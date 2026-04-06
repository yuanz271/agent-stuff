/**
 * Memory extension — bounded, file-backed persistent memory across sessions.
 *
 * Two stores:
 *   MEMORY.md — agent's personal notes (environment, conventions, lessons)
 *   USER.md   — user profile (preferences, communication style, identity)
 *
 * Injected into the system prompt as a frozen snapshot at session start.
 * Agent manages memory via the `memory` tool (add/replace/remove).
 *
 * See SPEC.md for full design.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { join } from "path";
import { homedir } from "os";
import { MemoryStore } from "./store.js";

const MEMORY_DIR = join(homedir(), ".pi", "agent", "memories");

export default function memory(pi: ExtensionAPI) {
	const store = new MemoryStore(MEMORY_DIR);

	// ── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event: any, _ctx) => {
		await store.loadFromDisk();
	});

	pi.on("session_before_compact", async (_event, _ctx) => {
		await store.loadFromDisk();
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
			"- You learn a convention, API quirk, or workflow specific to this user's setup\n" +
			"- You identify a stable fact that will be useful again in future sessions\n\n" +
			"PRIORITY: User preferences and corrections > environment facts > procedural knowledge. " +
			"The most valuable memory prevents the user from having to repeat themselves.\n\n" +
			"Do NOT save task progress, session outcomes, or temporary state.\n\n" +
			"TWO TARGETS:\n" +
			"- 'user': who the user is — name, role, preferences, communication style, pet peeves\n" +
			"- 'memory': your notes — environment facts, project conventions, tool quirks, lessons learned\n\n" +
			"ACTIONS: add (new entry), replace (update existing — old_text identifies it), " +
			"remove (delete — old_text identifies it), read (show current entries).\n\n" +
			"SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.",
		promptSnippet: "memory — save/update/remove persistent notes (memory) or user profile (user)",
		promptGuidelines: [
			"Proactively save user preferences, environment facts, and lessons learned to memory.",
			"When memory is above 80% capacity, consolidate entries before adding new ones.",
			"Do not save task progress, session-specific ephemera, or easily re-discovered facts.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "replace", "remove", "read"] as const, {
				description: "The action to perform.",
			}),
			target: StringEnum(["memory", "user"] as const, {
				description: "Which memory store: 'memory' for personal notes, 'user' for user profile.",
			}),
			content: Type.Optional(
				Type.String({ description: "The entry content. Required for 'add' and 'replace'." }),
			),
			old_text: Type.Optional(
				Type.String({ description: "Short unique substring identifying the entry to replace or remove." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, target, content, old_text } = params;
			let result;

			try {
				switch (action) {
					case "add":
						if (!content) {
							result = { success: false, error: "Content is required for 'add' action." };
						} else {
							result = await store.add(target, content);
						}
						break;

					case "replace":
						if (!old_text) {
							result = { success: false, error: "old_text is required for 'replace' action." };
						} else if (!content) {
							result = { success: false, error: "content is required for 'replace' action." };
						} else {
							result = await store.replace(target, old_text, content);
						}
						break;

					case "remove":
						if (!old_text) {
							result = { success: false, error: "old_text is required for 'remove' action." };
						} else {
							result = await store.remove(target, old_text);
						}
						break;

					case "read":
						result = store.read(target);
						break;

					default:
						result = { success: false, error: `Unknown action '${action}'. Use: add, replace, remove, read.` };
				}
			} catch (error) {
				// Boundary-safe translation: file-system read/write failures should fail the tool
				// call clearly without silently degrading to empty memory state.
				const message = error instanceof Error ? error.message : String(error);
				result = { success: false, error: `Memory operation failed: ${message}` };
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: result,
				isError: !result.success,
			};
		},
	});
}
