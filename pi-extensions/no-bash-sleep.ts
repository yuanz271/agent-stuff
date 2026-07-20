/**
 * No-Bash-Sleep Extension
 *
 * Intercepts bash tool calls and blocks any that invoke `sleep` with a delay
 * longer than MAX_SLEEP_SECONDS (5 minutes). Short sleeps (retry backoff,
 * debounce) are allowed. Long sleeps block the agent and prevent it from
 * accepting new input.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_SLEEP_SECONDS = 300; // 5 minutes

/**
 * Strip string literals and comments from a shell command so we don't
 * false-positive on `sleep` appearing inside quoted strings or comments.
 *
 * Handles:
 * - single-quoted strings: 'no sleep here'
 * - double-quoted strings: "no sleep here"
 * - $'...' ANSI-C quoted strings
 * - heredocs (<<EOF ... EOF)
 * - inline # comments (stripped to end of line)
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
			i++;
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

		// Heredoc: <<[-]WORD
		if (ch === "<" && command[i + 1] === "<") {
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

		// Inline comment: strip # to end of line
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
 * Find all `sleep <duration>` invocations in the stripped command.
 *
 * Matches `sleep` when preceded by start-of-string, ;, |, &, (, {, or
 * newline (with optional whitespace); by the shell keywords `do`, `then`,
 * `else`, or `elif`; or by a case-pattern `)`, and captures the duration
 * argument.
 *
 * False negatives are preferred over false positives, so this is not a
 * full shell parser and can still miss unusual constructs.
 */
function findSleepInvocations(stripped: string): string[] {
	const durations: string[] = [];
	const boundary = String.raw`(?:^|[;|&(){\n]|\b(?:do|then|else|elif)\b|\))`;
	const re = new RegExp(`${boundary}\\s*sleep\\s+([^\\s;|&)}\\n]+)`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(stripped)) !== null) {
		durations.push(m[1]);
	}
	// Also match bare `sleep` with no argument
	const bareRe = new RegExp(`${boundary}\\s*sleep(?=\\s*(?:$|[;|&)}\\n]))`, "g");
	while ((m = bareRe.exec(stripped)) !== null) {
		durations.push("");
	}
	return durations;
}

/**
 * Parse a sleep duration string to seconds.
 *
 * Supports:
 * - plain number: "5" → 5s
 * - suffix s: "30s" → 30s
 * - suffix m: "5m" → 300s
 * - suffix h: "2h" → 7200s
 * - suffix d: "1d" → 86400s
 * - decimal: "1.5m" → 90s
 *
 * Returns null if the duration is a variable or cannot be parsed.
 */
function parseSleepSeconds(duration: string): number | null {
	if (!duration) return null;
	// Variable reference — can't determine value
	if (duration.startsWith("$")) return null;

	const m = duration.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/i);
	if (!m) return null;

	const value = parseFloat(m[1]);
	const unit = (m[2] ?? "s").toLowerCase();

	switch (unit) {
		case "s": return value;
		case "m": return value * 60;
		case "h": return value * 3600;
		case "d": return value * 86400;
		default: return value;
	}
}

export default function noSleepExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;

		const command = event.input.command;
		if (typeof command !== "string") return;

		const stripped = stripStringsAndComments(command);
		const durations = findSleepInvocations(stripped);
		if (durations.length === 0) return;

		for (const duration of durations) {
			const seconds = parseSleepSeconds(duration);

			// Unparseable or variable — block conservatively
			if (seconds === null) {
				return {
					block: true,
					reason:
						`sleep with dynamic or unparseable duration (${duration || "no argument"}) is not allowed — ` +
						`it may block the agent indefinitely. Use /schedule-prompt for delayed work instead.`,
				};
			}

			// Long sleep — block
			if (seconds > MAX_SLEEP_SECONDS) {
				const minutes = Math.round(seconds / 60);
				return {
					block: true,
					reason:
						`sleep ${duration} (${minutes} min) exceeds the ${MAX_SLEEP_SECONDS / 60}-minute limit. ` +
						`Short sleeps (≤${MAX_SLEEP_SECONDS}s) are allowed for retry backoff or debounce. ` +
						`For longer delays, use /schedule-prompt instead.`,
				};
			}
		}

		// All sleeps are within the allowed limit — allow through
	});
}
