import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

type InitArgs = {
	extraInstructions?: string;
};

type RepoInfo = {
	repoRoot: string;
	isGitRepo: boolean;
};

const MAX_LIST_ITEMS = 12;
const MAX_SCRIPT_NAMES = 12;
const MAX_COMMIT_SUBJECTS = 8;

const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

function parseArgs(args: string | undefined): InitArgs {
	const extraInstructions = args?.trim();
	return {
		extraInstructions: extraInstructions || undefined,
	};
}

function truncateList(items: string[], limit: number): string[] {
	if (items.length <= limit) return items;
	return [...items.slice(0, limit), `… (+${items.length - limit} more)`];
}

function formatList(items: string[], emptyText: string): string {
	if (items.length === 0) return emptyText;
	return truncateList(items, MAX_LIST_ITEMS).join(", ");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function getRepoInfo(pi: ExtensionAPI, cwd: string): Promise<RepoInfo> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code === 0) {
		const repoRoot = result.stdout.trim();
		if (repoRoot) {
			return { repoRoot, isGitRepo: true };
		}
	}

	return { repoRoot: cwd, isGitRepo: false };
}

async function readPackageJsonSummary(repoRoot: string): Promise<string[]> {
	const packageJsonPath = path.join(repoRoot, "package.json");
	if (!(await fileExists(packageJsonPath))) {
		return ["- package.json: not found"];
	}

	try {
		const raw = await fs.readFile(packageJsonPath, "utf8");
		const pkg = JSON.parse(raw) as {
			name?: string;
			version?: string;
			type?: string;
			packageManager?: string;
			scripts?: Record<string, string>;
		};

		const lines: string[] = [];
		const metaBits = [
			pkg.name ? `name=${pkg.name}` : undefined,
			pkg.version ? `version=${pkg.version}` : undefined,
			pkg.type ? `type=${pkg.type}` : undefined,
			pkg.packageManager ? `packageManager=${pkg.packageManager}` : undefined,
		].filter((value): value is string => Boolean(value));

		lines.push(`- package.json: ${metaBits.length > 0 ? metaBits.join(", ") : "present"}`);

		const scriptNames = Object.keys(pkg.scripts ?? {}).sort((a, b) => a.localeCompare(b));
		lines.push(`- package scripts: ${scriptNames.length > 0 ? truncateList(scriptNames, MAX_SCRIPT_NAMES).join(", ") : "(none)"}`);
		return lines;
	} catch (error) {
		return [`- package.json: present but could not be parsed (${error instanceof Error ? error.message : String(error)})`];
	}
}

async function readTopLevelSummary(repoRoot: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(repoRoot, { withFileTypes: true });
		const directories = entries
			.filter((entry) => entry.isDirectory() && entry.name !== ".git")
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
		const files = entries
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));

		return [
			`- top-level directories: ${formatList(directories, "(none)")}`,
			`- top-level files: ${formatList(files, "(none)")}`,
		];
	} catch (error) {
		return [`- top-level entries: unavailable (${error instanceof Error ? error.message : String(error)})`];
	}
}

async function readCommitSummary(pi: ExtensionAPI, repoRoot: string, isGitRepo: boolean): Promise<string[]> {
	if (!isGitRepo) {
		return ["- recent commits: unavailable (not a git repository)"];
	}

	const result = await pi.exec("git", ["log", `--pretty=format:%s`, `-n`, String(MAX_COMMIT_SUBJECTS)], { cwd: repoRoot });
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		return [`- recent commits: unavailable (${stderr || "git log failed"})`];
	}

	const subjects = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (subjects.length === 0) {
		return ["- recent commits: (none found)"];
	}

	return [
		"- recent commit subjects:",
		...subjects.map((subject) => `  - ${subject}`),
	];
}

async function buildRepoContext(pi: ExtensionAPI, repoInfo: RepoInfo, targetPath: string): Promise<string> {
	const lines: string[] = [
		`- repo root: ${repoInfo.repoRoot}`,
		`- target file: ${targetPath}`,
		`- git repository: ${repoInfo.isGitRepo ? "yes" : "no"}`,
	];

	lines.push(...(await readTopLevelSummary(repoInfo.repoRoot)));
	lines.push(...(await readPackageJsonSummary(repoInfo.repoRoot)));
	lines.push(...(await readCommitSummary(pi, repoInfo.repoRoot, repoInfo.isGitRepo)));

	return lines.join("\n");
}

function buildInitMessage(options: {
	repoRoot: string;
	targetPath: string;
	repoContext: string;
	initPrompt: string;
	extraInstructions?: string;
}): string {
	const sections = [
		"You are executing pi's /init bootstrap command.",
		`Target repository root: ${options.repoRoot}`,
		`Generate or update the repository contributor guide at ${options.targetPath}.`,
		"Mimic the /init experience from tools like Codex, Claude Code, and OpenCode, but keep the behavior pi-specific.",
		"Inspect the repository before writing so the document is specific to this repo. Do not only describe what you would do — actually write the AGENTS.md file.",
		"If AGENTS.md already exists, update or replace it directly as part of this /init flow.",
		"The repository context below is a convenience snapshot. Verify details with tools as needed before writing.",
		"",
		"Repository context:",
		options.repoContext,
	];

	if (options.extraInstructions) {
		sections.push("", `Additional user instructions: ${options.extraInstructions}`);
	}

	sections.push("", "Use the following prompt as the primary content/style instruction:", "", options.initPrompt.trim());
	return sections.join("\n");
}

export default function initExtension(pi: ExtensionAPI): void {
	pi.registerCommand("init", {
		description: "Generate the repo's AGENTS.md from the embedded /init prompt",
		handler: async (args, ctx) => {
			const parsedArgs = parseArgs(args);
			const repoInfo = await getRepoInfo(pi, ctx.cwd);
			const targetPath = path.join(repoInfo.repoRoot, "AGENTS.md");

			const repoContext = await buildRepoContext(pi, repoInfo, targetPath);
			const message = buildInitMessage({
				repoRoot: repoInfo.repoRoot,
				targetPath,
				repoContext,
				initPrompt: INIT_PROMPT,
				extraInstructions: parsedArgs.extraInstructions,
			});

			if (ctx.isIdle()) {
				ctx.ui.notify(`Starting /init for ${repoInfo.repoRoot}`, "info");
				pi.sendUserMessage(message);
				return;
			}

			pi.sendUserMessage(message, { deliverAs: "followUp" });
			ctx.ui.notify("/init queued as a follow-up", "info");
		},
	});
}
