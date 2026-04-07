/**
 * MemoryStore — bounded, file-backed persistent memory.
 *
 * Single store: MEMORY.md — user preferences, environment facts, communication
 * style, cross-project conventions. Think of it as IDE-local settings: private
 * to this agent instance, not committed to any repo.
 *
 * Two parallel states:
 *   - snapshot: frozen at loadFromDisk(), used for system prompt injection.
 *     Never mutated mid-session. Keeps prefix cache stable.
 *   - entries: live state, mutated by tool calls, persisted to disk.
 *     Tool responses always reflect this live state.
 */

import { readFile, open, rename, unlink, mkdir, access, type FileHandle } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { scanContent } from "./scanner.js";

const ENTRY_DELIMITER = "\n§\n";
const SEPARATOR = "═".repeat(46);
const CHAR_LIMIT = 3000;

export interface MutationResult {
	success: boolean;
	error?: string;
	entries?: string[];
	usage?: string;
	entry_count?: number;
	message?: string;
	matches?: string[];
}

// ── MemoryStore ──────────────────────────────────────────────────────────────

export class MemoryStore {
	private entries: string[] = [];
	private snapshot: string = "";
	private readonly path: string;

	/** Serializes mutations so reload-modify-write is not interleaved. */
	private _lockChain: Promise<void> = Promise.resolve();

	constructor(dir: string) {
		this.path = join(dir, "MEMORY.md");
	}

	// ── Load / Snapshot ────────────────────────────────────────────────────

	/** Read entries from disk and capture frozen snapshot. */
	async loadFromDisk(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		// One-time idempotent migration: USER.md → MEMORY.md
		// Guard with existence check: POSIX rename() overwrites destination silently,
		// so only attempt rename when MEMORY.md is absent.
		const legacyPath = join(dirname(this.path), "USER.md");
		let targetExists = true;
		try { await access(this.path); } catch { targetExists = false; }
		if (!targetExists) {
			try {
				await rename(legacyPath, this.path);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				// ENOENT: no USER.md either — nothing to migrate
			}
		}
		this.entries = await this._readFile();
		this.snapshot = this._renderBlock();
	}

	/** Return the frozen snapshot block for system prompt injection. */
	getSnapshotBlock(): string {
		return this.snapshot;
	}

	/** Compact status string for footer display, e.g. "🧠 115/3,575". */
	getStatusText(): string {
		return `🧠 ${fmt(this._charCount())}/${fmt(CHAR_LIMIT)}`;
	}

	// ── Mutations ──────────────────────────────────────────────────────────

	async add(content: string): Promise<MutationResult> {
		content = content.trim();
		const invalid = _validateContent(content);
		if (invalid) return invalid;

		return this._withLock(async () => {
			await this._reload();

			if (this.entries.includes(content)) {
				return this._successResponse("Entry already exists (no duplicate added).");
			}

			const projected = [...this.entries, content].join(ENTRY_DELIMITER).length;
			if (projected > CHAR_LIMIT) {
				const current = this._charCount();
				return {
					success: false,
					error: `Memory at ${fmt(current)}/${fmt(CHAR_LIMIT)} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
					entries: this.entries,
					usage: `${this._pct()}% — ${fmt(current)}/${fmt(CHAR_LIMIT)} chars`,
				};
			}

			this.entries.push(content);
			await this._writeFileAtomic();
			return this._successResponse("Entry added.");
		});
	}

	async replace(oldText: string, newContent: string): Promise<MutationResult> {
		oldText = oldText.trim();
		newContent = newContent.trim();
		if (!oldText) return { success: false, error: "old_text cannot be empty." };
		const invalid = _validateContent(newContent, "content cannot be empty. Use 'remove' to delete entries.");
		if (invalid) return invalid;

		return this._withLock(async () => {
			await this._reload();

			const matchResult = this._findMatch(oldText);
			if (!matchResult.ok) return matchResult.error!;

			const idx = matchResult.index!;
			const test = [...this.entries];
			test[idx] = newContent;
			const projected = test.join(ENTRY_DELIMITER).length;
			if (projected > CHAR_LIMIT) {
				return {
					success: false,
					error: `Replacement would put memory at ${fmt(projected)}/${fmt(CHAR_LIMIT)} chars. Shorten the new content or remove other entries first.`,
				};
			}

			this.entries[idx] = newContent;
			await this._writeFileAtomic();
			return this._successResponse("Entry replaced.");
		});
	}

	async remove(oldText: string): Promise<MutationResult> {
		oldText = oldText.trim();
		if (!oldText) return { success: false, error: "old_text cannot be empty." };

		return this._withLock(async () => {
			await this._reload();

			const matchResult = this._findMatch(oldText);
			if (!matchResult.ok) return matchResult.error!;

			this.entries.splice(matchResult.index!, 1);
			await this._writeFileAtomic();
			return this._successResponse("Entry removed.");
		});
	}

	async read(): Promise<MutationResult> {
		return this._withLock(async () => {
			await this._reload();
			return this._successResponse();
		});
	}

	// ── Private helpers ────────────────────────────────────────────────────

	private _charCount(): number {
		if (!this.entries.length) return 0;
		return this.entries.join(ENTRY_DELIMITER).length;
	}

	private _pct(): number {
		return Math.min(100, Math.round((this._charCount() / CHAR_LIMIT) * 100));
	}

	private _successResponse(message?: string): MutationResult {
		const current = this._charCount();
		const result: MutationResult = {
			success: true,
			entries: this.entries,
			usage: `${this._pct()}% — ${fmt(current)}/${fmt(CHAR_LIMIT)} chars`,
			entry_count: this.entries.length,
		};
		if (message) result.message = message;
		return result;
	}

	private _findMatch(substring: string): { ok: boolean; index?: number; error?: MutationResult } {
		const matches: [number, string][] = [];
		for (let i = 0; i < this.entries.length; i++) {
			if (this.entries[i].includes(substring)) matches.push([i, this.entries[i]]);
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

	private _renderBlock(): string {
		if (!this.entries.length) return "";
		const content = this.entries.join(ENTRY_DELIMITER);
		const current = content.length;
		const pct = Math.min(100, Math.round((current / CHAR_LIMIT) * 100));
		const header = `MEMORY [${pct}% — ${fmt(current)}/${fmt(CHAR_LIMIT)} chars]`;
		return `${SEPARATOR}\n${header}\n${SEPARATOR}\n${content}`;
	}

	private async _reload(): Promise<void> {
		this.entries = await this._readFile();
	}

	private async _readFile(): Promise<string[]> {
		try {
			const raw = await readFile(this.path, "utf8");
			if (!raw.trim()) return [];
			const entries = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
			// Deduplicate (preserve order, keep first)
			return Array.from(new Map(entries.map((e) => [e, e])).values());
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") return [];
			throw new Error(`Failed to read memory file ${this.path}: ${err.message}`);
		}
	}

	private async _writeFileAtomic(): Promise<void> {
		const content = this.entries.join(ENTRY_DELIMITER);
		const tmp = this.path + `.tmp.${randomBytes(4).toString("hex")}`;
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
			await rename(tmp, this.path);
		} catch (err) {
			if (fileHandle) {
				try { await fileHandle.close(); } catch { /* best-effort */ }
			}
			try { await unlink(tmp); } catch { /* best-effort */ }
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
	if (content.includes(ENTRY_DELIMITER)) return { success: false, error: "Content must not contain the entry delimiter '\\n§\\n'." };
	const scanError = scanContent(content);
	if (scanError) return { success: false, error: scanError };
	return null;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}
