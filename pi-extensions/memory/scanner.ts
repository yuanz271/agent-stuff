/**
 * Content security scanning for memory entries.
 *
 * Memory entries are injected into the system prompt, so they must not
 * contain prompt injection, credential exfiltration, or invisible
 * character payloads.
 */

const THREAT_PATTERNS: [RegExp, string][] = [
	// Prompt injection
	[/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
	[/you\s+are\s+now\s+/i, "role_hijack"],
	[/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
	[/system\s+prompt\s+override/i, "sys_prompt_override"],
	[/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
	[/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
	// Exfiltration
	[/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
	[/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
	[/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
	// Persistence / backdoor — broad by design because these entries are
	// reinjected into future system prompts. Until there is an explicit
	// allowlist/escape hatch for legitimate environment notes, we prefer
	// blocking any mention of these persistence indicators.
	[/authorized_keys/i, "ssh_backdoor"],
	[/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access"],
];

const INVISIBLE_CHARS = new Set([
	"\u200b", // zero-width space
	"\u200c", // zero-width non-joiner
	"\u200d", // zero-width joiner
	"\u2060", // word joiner
	"\ufeff", // byte order mark (zero-width no-break space)
	"\u202a", // left-to-right embedding
	"\u202b", // right-to-left embedding
	"\u202c", // pop directional formatting
	"\u202d", // left-to-right override
	"\u202e", // right-to-left override
]);

/**
 * Scan memory content for injection/exfiltration patterns.
 * @returns Error message if blocked, `null` if clean.
 */
export function scanContent(content: string): string | null {
	for (const char of content) {
		if (INVISIBLE_CHARS.has(char)) {
			return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} (possible injection).`;
		}
	}
	for (const [pattern, id] of THREAT_PATTERNS) {
		if (pattern.test(content)) {
			return `Blocked: content matches threat pattern '${id}'. Memory entries are injected into the system prompt and must not contain injection or exfiltration payloads.`;
		}
	}
	return null;
}
