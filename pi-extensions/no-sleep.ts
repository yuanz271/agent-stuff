/**
 * No-Sleep Extension
 *
 * Intercepts bash tool calls and blocks any that invoke `sleep`.
 * Prevents agents from using sleep to wait/poll, which blocks Pi
 * and prevents it from accepting new input.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Strip string literals and comments from a shell command so we don't
 * false-positive on `sleep` appearing inside quoted strings or comments.
 *
 * Handles:
 * - single-quoted strings: 'no sleep here'
 * - double-quoted strings: "no sleep here"
 * - $'...' ANSI-C quoted strings
 * - inline # comments (only when preceded by whitespace or start of token)
 * - heredocs (<<EOF ... EOF) replaced with placeholder
 *
 * Not a full shell parser — errs on the side of false negatives (misses some
 * quoted sleeps) rather than false positives (blocking valid commands).
 */
function stripStringsAndComments(command: string): string {
	let result = "";
	let i = 0;

	while (i < command.length) {
		const ch = command[i];

		// Single-quoted string: 'literal' — no escapes inside
		if (ch === "'") {
			i++;
			while (i < command.length && command[i] !== "'") i++;
			i++; // skip closing quote
			result += " ";
			continue;
		}

		// $'...' ANSI-C quoted string
		if (ch === "$" && command[i + 1] === "'") {
			i += 2;
			while (i < command.length) {
				if (command[i] === "\\" && i + 1 < command.length) {
					i += 2;
				} else if (command[i] === "'") {
					i++;
					break;
				} else {
					i++;
				}
			}
			result += " ";
			continue;
		}

		// Double-quoted string
		if (ch === '"') {
			i++;
			while (i < command.length) {
				if (command[i] === "\\" && i + 1 < command.length) {
					i += 2;
				} else if (command[i] === '"') {
					i++;
					break;
				} else {
					i++;
				}
			}
			result += " ";
			continue;
		}

		// Heredoc: <<[-]WORD or <<[-]'WORD' or <<[-]"WORD"
		if (ch === "<" && command[i + 1] === "<") {
			// Find end of line to get delimiter, then skip until delimiter line
			const rest = command.slice(i);
			const heredocMatch = rest.match(/^<<-?\s*['"]?(\w+)['"]?\n/);
			if (heredocMatch) {
				const delimiter = heredocMatch[1];
				const afterHeredocStart = i + heredocMatch[0].length;
				const delimiterLine = new RegExp(`(^|\\n)\\t*${delimiter}\\n`);
				const bodyMatch = command.slice(afterHeredocStart).match(delimiterLine);
				if (bodyMatch && bodyMatch.index !== undefined) {
					i = afterHeredocStart + bodyMatch.index + bodyMatch[0].length;
				} else {
					i = command.length;
				}
				result += " ";
				continue;
			}
		}

		// Inline comment: # preceded by whitespace, shell separator, or word character
		// In shell, `#` starts a comment whenever it appears after a token boundary
		// (whitespace, ;, |, &, (, newline) OR after a word character (bash treats
		// `word#comment` as word followed by comment in most contexts).
		// We strip all # to end-of-line to avoid false negatives.
		if (ch === "#") {
			while (i < command.length && command[i] !== "\n") i++;
			result += " ";
			continue;
		}

		result += ch;
		i++;
	}

	return result;
}

/**
 * Check if the stripped command contains a `sleep` invocation.
 *
 * Matches `sleep` when preceded by start-of-string, ;, |, &, (, {, or
 * newline (with optional whitespace) — i.e. as the first token after a
 * shell separator.
 *
 * Does NOT match:
 * - `sleep` as an argument (e.g. `echo sleep 5`)
 * - variable names (e.g. $sleep, SLEEP_TIME=5)
 * - substrings (e.g. "asleep", "nosleep")
 *
 * Known limitation: `sleep` after shell keywords `do`/`then`/`else` is only
 * caught when preceded by a semicolon (e.g. `; do sleep 1`). The pattern
 * `do\nsleep` without a semicolon is missed. False negatives are preferred
 * over false positives here.
 */
function containsSleepCommand(stripped: string): boolean {
	return /(?:^|[;|&({\n])\s*sleep(?=\s|$|[;|&)}\n])/.test(stripped);
}

export default function noSleepExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;

		const command = event.input.command;
		if (typeof command !== "string") return;

		const stripped = stripStringsAndComments(command);
		if (!containsSleepCommand(stripped)) return;

		return {
			block: true,
			reason:
				"sleep is not allowed in bash tool calls — it blocks the agent and prevents it from accepting new input. " +
				"Use /schedule-prompt for delayed or recurring work instead.",
		};
	});
}
