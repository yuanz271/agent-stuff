/**
 * Memory extension — persistent user preferences across sessions.
 *
 * Single store: MEMORY.md under ~/.pi/agent/memories/
 * Stores user preferences, environment facts, communication style —
 * anything personal and cross-project. Think IDE-local settings:
 * private to this agent instance, not committed to any repo.
 *
 * Injected into the system prompt as a frozen snapshot at session start.
 * Agent manages memory via the `memory` tool (add/replace/remove/read).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { join } from "path";
import { homedir } from "os";
import { MemoryStore } from "./store.js";

const MEMORY_DIR = join(homedir(), ".pi", "agent", "memories");
const STATUS_KEY = "memory";

export default function memory(pi: ExtensionAPI) {
	const store = new MemoryStore(MEMORY_DIR);

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, store.getStatusText());
	}

	// ── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event: any, ctx) => {
		await store.loadFromDisk();
		updateStatus(ctx);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		await store.loadFromDisk();
		updateStatus(ctx);
	});

	// ── System prompt injection ────────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const block = store.getSnapshotBlock();
		if (!block) return;
		return { systemPrompt: event.systemPrompt + "\n\n" + block };
	});

	// ── Tool registration ──────────────────────────────────────────────────

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Save durable information to persistent memory that survives across sessions. " +
			"Memory is injected into future system prompts, so keep it compact and focused on facts " +
			"that will still matter later.\n\n" +
			"WHEN TO SAVE (do this proactively, don't wait to be asked):\n" +
			"- User corrects you or says 'remember this' / 'don't do that again'\n" +
			"- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n" +
			"- You discover something about the environment (OS, installed tools, project structure)\n" +
			"- You learn a convention or workflow specific to this user's setup\n\n" +
			"PRIORITY: User preferences and corrections > environment facts > workflow habits. " +
			"The most valuable memory prevents the user from having to repeat themselves.\n\n" +
			"Do NOT save task progress, session outcomes, or temporary state. " +
			"Repo-specific conventions belong in AGENTS.md, not here.\n\n" +
			"ACTIONS: add (new entry), replace (update existing — old_text identifies it), " +
			"remove (delete — old_text identifies it), read (show current entries).\n\n" +
			"SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, repo-specific conventions, and temporary task state.",
		promptSnippet: "memory — save/update/remove persistent user preferences and environment facts",
		promptGuidelines: [
			"Proactively save user preferences, environment facts, and cross-project workflow habits to memory.",
			"Do not save repo-specific conventions — those belong in AGENTS.md.",
			"When memory is above 80% capacity, consolidate entries before adding new ones.",
			"Do not save task progress, session-specific ephemera, or easily re-discovered facts.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "replace", "remove", "read"] as const, {
				description: "The action to perform.",
			}),
			content: Type.Optional(
				Type.String({ description: "The entry content. Required for 'add' and 'replace'." }),
			),
			old_text: Type.Optional(
				Type.String({ description: "Short unique substring identifying the entry to replace or remove." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, content, old_text } = params;
			let result;

			try {
				switch (action) {
					case "add":
						if (!content) {
							result = { success: false, error: "content is required for 'add' action." };
						} else {
							result = await store.add(content);
						}
						break;

					case "replace":
						if (!old_text) {
							result = { success: false, error: "old_text is required for 'replace' action." };
						} else if (!content) {
							result = { success: false, error: "content is required for 'replace' action." };
						} else {
							result = await store.replace(old_text, content);
						}
						break;

					case "remove":
						if (!old_text) {
							result = { success: false, error: "old_text is required for 'remove' action." };
						} else {
							result = await store.remove(old_text);
						}
						break;

					case "read":
						result = await store.read();
						break;

					default:
						result = { success: false, error: `Unknown action '${action}'. Use: add, replace, remove, read.` };
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result = { success: false, error: `Memory operation failed: ${message}` };
			}

			updateStatus(ctx);

			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: result,
				isError: !result.success,
			};
		},
	});
}
