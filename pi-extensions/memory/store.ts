/**
 * MemoryStore — bounded, file-backed persistent memory.
 *
 * Two parallel states:
 *   - snapshot: frozen at loadFromDisk(), used for system prompt injection.
 *     Never mutated mid-session. Keeps prefix cache stable.
 *   - entries: live state, mutated by tool calls, persisted to disk.
 *     Tool responses always reflect this live state.
 *
 * See SPEC.md for full design rationale.
 */

import { readFile, open, rename, unlink, mkdir, type FileHandle } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { scanContent } from "./scanner.js";

const ENTRY_DELIMITER = "\n§\n";
const SEPARATOR = "═".repeat(46);

// ── Types ────────────────────────────────────────────────────────────────────

export interface MutationResult {
	success: boolean;
	error?: string;
	target?: string;
	entries?: string[];
	usage?: string;
	entry_count?: number;
	message?: string;
	matches?: string[];
}

type Target = "memory" | "user";

// ── MemoryStore ──────────────────────────────────────────────────────────────

export class MemoryStore {
	private entries: Record<Target, string[]> = { memory: [], user: [] };
	private snapshot: Record<Target, string> = { memory: "", user: "" };
	private limits: Record<Target, number>;
	private dir: string;

	/** Serializes mutations so reload-modify-write is not interleaved. */
	private _lockChain: Promise<void> = Promise.resolve();

	constructor(dir: string, memoryLimit = 2200, userLimit = 1375) {
		this.dir = dir;
		this.limits = { memory: memoryLimit, user: userLimit };
	}

	// ── Load / Snapshot ────────────────────────────────────────────────────

	/** Read entries from disk and capture frozen snapshot. */
	async loadFromDisk(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		this.entries.memory = await this._readFile(this._path("memory"));
		this.entries.user = await this._readFile(this._path("user"));
		this.snapshot = {
			memory: this._renderBlock("memory"),
			user: this._renderBlock("user"),
		};
	}

	/**
	 * Return the frozen snapshot block for system prompt injection.
	 * Combines both stores. Empty stores are omitted.
	 */
	getSnapshotBlock(): string {
		const parts: string[] = [];
		if (this.snapshot.memory) parts.push(this.snapshot.memory);
		if (this.snapshot.user) parts.push(this.snapshot.user);
		return parts.join("\n\n");
	}

	// ── Mutations ──────────────────────────────────────────────────────────

	async add(target: Target, content: string): Promise<MutationResult> {
		content = content.trim();
		const invalid = _validateContent(content);
		if (invalid) return invalid;

		return this._withLock(async () => {
			await this._reloadTarget(target);
			const entries = this.entries[target];

			if (entries.includes(content)) {
				return this._successResponse(target, "Entry already exists (no duplicate added).");
			}

			const projected = [...entries, content].join(ENTRY_DELIMITER).length;
			if (projected > this.limits[target]) {
				const current = this._charCount(target);
				return {
					success: false,
					error: `Memory at ${fmt(current)}/${fmt(this.limits[target])} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
					entries,
					usage: `${this._pct(target)}% — ${fmt(current)}/${fmt(this.limits[target])} chars`,
				};
			}

			entries.push(content);
			await this._writeFileAtomic(this._path(target), entries);
			return this._successResponse(target, "Entry added.");
		});
	}

	async replace(target: Target, oldText: string, newContent: string): Promise<MutationResult> {
		oldText = oldText.trim();
		newContent = newContent.trim();
		if (!oldText) return { success: false, error: "old_text cannot be empty." };
		const invalid = _validateContent(newContent, "content cannot be empty. Use 'remove' to delete entries.");
		if (invalid) return invalid;

		return this._withLock(async () => {
			await this._reloadTarget(target);
			const entries = this.entries[target];

			const matchResult = this._findMatch(entries, oldText);
			if (!matchResult.ok) return matchResult.error!;

			const idx = matchResult.index!;
			const test = [...entries];
			test[idx] = newContent;
			const projected = test.join(ENTRY_DELIMITER).length;
			if (projected > this.limits[target]) {
				return {
					success: false,
					error: `Replacement would put memory at ${fmt(projected)}/${fmt(this.limits[target])} chars. Shorten the new content or remove other entries first.`,
				};
			}

			entries[idx] = newContent;
			await this._writeFileAtomic(this._path(target), entries);
			return this._successResponse(target, "Entry replaced.");
		});
	}

	async remove(target: Target, oldText: string): Promise<MutationResult> {
		oldText = oldText.trim();
		if (!oldText) return { success: false, error: "old_text cannot be empty." };

		return this._withLock(async () => {
			await this._reloadTarget(target);
			const entries = this.entries[target];

			const matchResult = this._findMatch(entries, oldText);
			if (!matchResult.ok) return matchResult.error!;

			entries.splice(matchResult.index!, 1);
			await this._writeFileAtomic(this._path(target), entries);
			return this._successResponse(target, "Entry removed.");
		});
	}

	// ── Read (for explicit read action) ────────────────────────────────────

	async read(target: Target): Promise<MutationResult> {
		return this._withLock(async () => {
			await this._reloadTarget(target);
			return this._successResponse(target);
		});
	}

	// ── Private helpers ────────────────────────────────────────────────────

	private _path(target: Target): string {
		return join(this.dir, target === "user" ? "USER.md" : "MEMORY.md");
	}

	private _charCount(target: Target): number {
		const entries = this.entries[target];
		if (!entries.length) return 0;
		return entries.join(ENTRY_DELIMITER).length;
	}

	private _pct(target: Target): number {
		const limit = this.limits[target];
		if (limit <= 0) return 0;
		return Math.min(100, Math.round((this._charCount(target) / limit) * 100));
	}

	private _successResponse(target: Target, message?: string): MutationResult {
		const entries = this.entries[target];
		const current = this._charCount(target);
		const limit = this.limits[target];
		const pct = this._pct(target);
		const result: MutationResult = {
			success: true,
			target,
			entries,
			usage: `${pct}% — ${fmt(current)}/${fmt(limit)} chars`,
			entry_count: entries.length,
		};
		if (message) result.message = message;
		return result;
	}

	private _findMatch(entries: string[], substring: string): { ok: boolean; index?: number; error?: MutationResult } {
		const matches: [number, string][] = [];
		for (let i = 0; i < entries.length; i++) {
			if (entries[i].includes(substring)) matches.push([i, entries[i]]);
		}
		if (matches.length === 0) {
			return { ok: false, error: { success: false, error: `No entry matched '${substring}'.` } };
		}
		if (matches.length > 1) {
			const unique = new Set(matches.map(([, e]) => e));
			if (unique.size > 1) {
				const previews = matches.map(([, e]) => (e.length > 80 ? e.slice(0, 80) + "..." : e));
				return {
					ok: false,
					error: {
						success: false,
						error: `Multiple entries matched '${substring}'. Be more specific.`,
						matches: previews,
					},
				};
			}
			// All identical — safe to operate on first
		}
		return { ok: true, index: matches[0][0] };
	}

	private _renderBlock(target: Target): string {
		const entries = this.entries[target];
		if (!entries.length) return "";

		const content = entries.join(ENTRY_DELIMITER);
		const current = content.length;
		const limit = this.limits[target];
		const pct = Math.min(100, Math.round((current / limit) * 100));

		const header =
			target === "user"
				? `USER PROFILE (who the user is) [${pct}% — ${fmt(current)}/${fmt(limit)} chars]`
				: `MEMORY (your personal notes) [${pct}% — ${fmt(current)}/${fmt(limit)} chars]`;

		return `${SEPARATOR}\n${header}\n${SEPARATOR}\n${content}`;
	}

	private async _reloadTarget(target: Target): Promise<void> {
		this.entries[target] = await this._readFile(this._path(target));
	}

	private async _readFile(path: string): Promise<string[]> {
		try {
			const raw = await readFile(path, "utf8");
			if (!raw.trim()) return [];
			const entries = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
			// Deduplicate (preserve order, keep first)
			return Array.from(new Map(entries.map((e) => [e, e])).values());
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") return [];
			throw new Error(`Failed to read memory file ${path}: ${err.message}`);
		}
	}

	private async _writeFileAtomic(path: string, entries: string[]): Promise<void> {
		const content = entries.join(ENTRY_DELIMITER);
		const tmp = path + `.tmp.${randomBytes(4).toString("hex")}`;
		let fileHandle: FileHandle | undefined;
		try {
			fileHandle = await open(tmp, "w");
			await fileHandle.writeFile(content, { encoding: "utf8" });
			await fileHandle.sync();
			try {
				await fileHandle.close();
			} finally {
				fileHandle = undefined;
			}
			await rename(tmp, path);
		} catch (err) {
			if (fileHandle) {
				try {
					await fileHandle.close();
				} catch {
					// Best-effort cleanup only; preserve the original write failure.
				}
			}
			try {
				await unlink(tmp);
			} catch {
				// Best-effort temp-file cleanup only; preserve the original write failure.
			}
			throw err;
		}
	}

	private _withLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this._lockChain;
		let resolve: () => void;
		this._lockChain = new Promise<void>((r) => { resolve = r; });
		return prev.then(fn).finally(() => resolve!());
	}
}

/** Shared pre-lock validation for content written to the store. */
function _validateContent(content: string, emptyMessage = "Content cannot be empty."): MutationResult | null {
	if (!content) return { success: false, error: emptyMessage };
	if (content.includes(ENTRY_DELIMITER)) return { success: false, error: "Content must not contain the entry delimiter '\n§\n'." };
	const scanError = scanContent(content);
	if (scanError) return { success: false, error: scanError };
	return null;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}
