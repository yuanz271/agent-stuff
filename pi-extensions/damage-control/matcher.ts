import os from "node:os";
import path from "node:path";
import type { PathRule } from "./types.js";

const GLOB_CHARS_PATTERN = /[*?]/;

const DELETE_COMMAND_PATTERN =
	/\b(rm|rmdir|mv|git\s+clean|git\s+rm|aws\s+s3\s+rm|aws\s+s3\s+rb|terminate-instances|delete-db-instance|delete-stack|delete-table|delete-cluster|delete-function|projects\s+delete|drop\s+table|drop\s+database|truncate\s+table)\b/i;

// Mutation commands that don't rely on redirect detection
const MUTATION_COMMAND_PATTERN =
	/(^|\s)(sed\s+-i|perl\s+-i|tee\s+|truncate\s+|chmod\s+|chown\s+|cp\s+|mv\s+|mkdir\s+|touch\s+|cat\s+.+>)(\s|$)|\binstall\b\s+-/i;

// Safe redirect patterns to strip before checking for dangerous > / >>
// Matches: N>/dev/null, &>/dev/null, N>&M, >&N (fd-to-fd redirects)
const SAFE_REDIRECT_PATTERN = /\d*>&\d+|\d*&?>\/dev\/null/g;

// After stripping safe redirects, any remaining > or >> is a real file redirect
const DANGEROUS_REDIRECT_PATTERN = />{1,2}/;

export function normalize_path(value: string): string {
	return value.replace(/\\/g, "/");
}

export function expand_home(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function has_glob(pattern: string): boolean {
	return GLOB_CHARS_PATTERN.test(pattern);
}

function escape_regex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function glob_to_regex(glob_pattern: string): RegExp {
	let regex = "^";

	for (let index = 0; index < glob_pattern.length; index += 1) {
		const char = glob_pattern[index];
		const next = glob_pattern[index + 1];

		if (char === "*" && next === "*") {
			regex += ".*";
			index += 1;
			continue;
		}
		if (char === "*") {
			regex += "[^/]*";
			continue;
		}
		if (char === "?") {
			regex += "[^/]";
			continue;
		}
		regex += escape_regex(char);
	}

	regex += "$";
	return new RegExp(regex);
}

function to_match_targets(target_path: string, cwd: string): {
	absolute: string;
	relative: string;
	basename: string;
	normalized_input: string;
	segments: string[];
} {
	const normalized_input = normalize_path(path.posix.normalize(expand_home(target_path)));
	const absolute = normalize_path(path.resolve(cwd, expand_home(target_path)));
	const relative = normalize_path(path.relative(cwd, absolute) || ".");
	const basename = path.posix.basename(normalized_input.replace(/\/$/, ""));
	const trimmed = normalized_input.replace(/^\/+/, "").replace(/\/+$/, "");
	const segments = trimmed && trimmed !== "." ? trimmed.split("/").filter(Boolean) : [];
	return { absolute, relative, basename, normalized_input, segments };
}

function ends_with_segments(target_segments: string[], pattern_segments: string[]): boolean {
	if (pattern_segments.length === 0 || pattern_segments.length > target_segments.length) return false;
	const offset = target_segments.length - pattern_segments.length;
	for (let index = 0; index < pattern_segments.length; index += 1) {
		if (target_segments[offset + index] !== pattern_segments[index]) return false;
	}
	return true;
}

function contains_segment_sequence(target_segments: string[], pattern_segments: string[]): boolean {
	if (pattern_segments.length === 0 || pattern_segments.length > target_segments.length) return false;
	for (let start = 0; start <= target_segments.length - pattern_segments.length; start += 1) {
		let matched = true;
		for (let index = 0; index < pattern_segments.length; index += 1) {
			if (target_segments[start + index] !== pattern_segments[index]) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

function shellish_tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (quote === "'") {
			if (char === "'") {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
			} else if (char === "\\") {
				escaped = true;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaped) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function sanitize_candidate_token(value: string): string {
	return value.replace(/^[([{]+/, "").replace(/[;,)\]}|&]+$/, "");
}

function extract_path_candidates_from_command(command: string): string[] {
	const nested_tokens = shellish_tokenize(command).flatMap((token) =>
		/\s/.test(token) ? shellish_tokenize(token) : [token],
	);
	const candidates = new Set<string>();
	const redirection_only = /^\d*(>{1,2}|<{1,2})$/;
	const redirection_with_target = /^\d*(>{1,2}|<{1,2})(.+)$/;
	const assignment_with_value = /^(?:--[^=]+|[A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

	for (let index = 1; index < nested_tokens.length; index += 1) {
		const token = nested_tokens[index];
		if (!token) continue;

		if (redirection_only.test(token)) {
			const next = sanitize_candidate_token(nested_tokens[index + 1] ?? "");
			if (next) candidates.add(next);
			continue;
		}

		const redirect_match = token.match(redirection_with_target);
		if (redirect_match) {
			const target = sanitize_candidate_token(redirect_match[2] ?? "");
			if (target) candidates.add(target);
			continue;
		}

		const assignment_match = token.match(assignment_with_value);
		if (assignment_match) {
			const value = sanitize_candidate_token(assignment_match[1] ?? "");
			if (value) candidates.add(value);
		}

		if (/^-{1,2}[^/].*$/.test(token) && !token.includes("=")) continue;
		const candidate = sanitize_candidate_token(token);
		if (candidate) candidates.add(candidate);
	}

	return [...candidates];
}

export function path_rule_matches_target(target_path: string, rule: PathRule, cwd: string): boolean {
	const raw_pattern = rule.pattern.trim();
	if (!raw_pattern) return false;

	const expanded_pattern = normalize_path(expand_home(raw_pattern));
	const targets = to_match_targets(target_path, cwd);

	if (has_glob(expanded_pattern)) {
		const regex = glob_to_regex(expanded_pattern);
		if (regex.test(targets.absolute) || regex.test(targets.relative) || regex.test(targets.normalized_input)) {
			return true;
		}
		if (!expanded_pattern.includes("/") && regex.test(targets.basename)) {
			return true;
		}
		return false;
	}

	if (expanded_pattern.endsWith("/")) {
		const base = expanded_pattern.slice(0, -1);
		if (path.isAbsolute(base)) {
			const absolute_dir = path.posix.normalize(base);
			return targets.absolute === absolute_dir || targets.absolute.startsWith(`${absolute_dir}/`);
		}

		const pattern_segments = base.replace(/^\/+/, "").split("/").filter(Boolean);
		return contains_segment_sequence(targets.segments, pattern_segments);
	}

	if (path.isAbsolute(expanded_pattern)) {
		const absolute_pattern = path.posix.normalize(expanded_pattern);
		return targets.absolute === absolute_pattern;
	}

	if (expanded_pattern.includes("/")) {
		const pattern_segments = expanded_pattern.replace(/^\/+/, "").split("/").filter(Boolean);
		return ends_with_segments(targets.segments, pattern_segments);
	}

	return targets.basename === expanded_pattern || targets.normalized_input === expanded_pattern;
}

export function command_mentions_path_rule(command: string, rule: PathRule, cwd: string): boolean {
	for (const candidate of extract_path_candidates_from_command(command)) {
		if (path_rule_matches_target(candidate, rule, cwd)) return true;
	}
	return false;
}

export function is_bash_delete_operation(command: string): boolean {
	return DELETE_COMMAND_PATTERN.test(command);
}

export function is_bash_mutation_operation(command: string): boolean {
	if (is_bash_delete_operation(command)) return true;
	if (MUTATION_COMMAND_PATTERN.test(command)) return true;
	// Check for real file redirects (>, >>) after stripping safe ones (2>/dev/null, 2>&1, etc.)
	const without_safe = command.replace(SAFE_REDIRECT_PATTERN, "");
	return DANGEROUS_REDIRECT_PATTERN.test(without_safe);
}

export function truncate_preview(value: string, max_length = 200): string {
	const single_line = value.replace(/\s+/g, " ").trim();
	if (single_line.length <= max_length) return single_line;
	return `${single_line.slice(0, max_length - 1)}…`;
}
