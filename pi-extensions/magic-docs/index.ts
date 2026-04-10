import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { complete, getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MAGIC_HEADER = /^# MAGIC DOC:/;
const JUDGE_IDLE_RUN_THRESHOLD = 2;
const JUDGE_COOLDOWN_MS = 5 * 60 * 1000;
const RESULT_GRACE_MS = 10_000;
const JUDGE_RECENT_MESSAGES = 30;
const JUDGE_MODEL_PROVIDER = "anthropic";
const JUDGE_MODEL_ID = "claude-haiku-4-5";
const UPDATE_REQUEST_VERSION = 1;

interface TrackedDoc {
	path: string;
	title: string;
	instruction?: string;
}

type DocFingerprint = {
	mtimeMs: number;
	size: number;
};

type UpdateRequestDoc = TrackedDoc & {
	fingerprint?: DocFingerprint;
};

type MagicDocsUpdateJudge = {
	reason: string;
};

type MagicDocsUpdateRequest = {
	version: 1;
	requestId: string;
	projectRoot: string;
	launchedAt: string;
	docs: UpdateRequestDoc[];
	judge: MagicDocsUpdateJudge;
};

type MagicDocsSkippedDoc = {
	path: string;
	reason: string;
};

type MagicDocsUpdateResult = {
	version: 1;
	requestId: string;
	completedAt: string;
	status: "completed" | "failed";
	changed: string[];
	unchanged: string[];
	skipped: MagicDocsSkippedDoc[];
	error?: string;
};

type MagicDocsLock = {
	requestId: string;
	pid: number;
	startedAt: string;
	projectRoot: string;
	sessionFile: string;
};

type MagicDocsState = {
	lastJudgeAt?: string;
	lastNotifiedResultRequestId?: string;
};

type RuntimePaths = {
	projectRoot: string;
	runtimeDir: string;
	statePath: string;
	lockPath: string;
	requestPath: string;
	resultPath: string;
	logPath: string;
	sessionPath: string;
	launchScriptPath: string;
	systemPromptPath: string;
};

const REPORT_TOOL = {
	name: "report_decision",
	description: "Report whether the magic docs should be updated",
	parameters: Type.Object({
		should_update: Type.Boolean({ description: "Whether the docs need updating" }),
		reason: Type.String({ description: "Brief reason" }),
	}),
};

function parseHeader(content: string): { title: string; instruction?: string } | null {
	const lines = content.split("\n");
	const idx = lines.findIndex((line) => line.trim() !== "");
	if (idx === -1 || !MAGIC_HEADER.test(lines[idx])) return null;

	const title = lines[idx].replace(/^# MAGIC DOC:\s*/, "").trim();
	if (!title) return null;

	const next = lines[idx + 1]?.trim();
	const instruction = next?.startsWith("*") && next.endsWith("*") ? next.slice(1, -1).trim() : undefined;
	return { title, instruction };
}

function textFrom(content: any[]): string | null {
	const first = content?.[0];
	return first && typeof first === "object" && first.type === "text" ? first.text : null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocation(): { command: string; argsPrefix: string[] } {
	const currentEntry = process.argv[1];
	const execName = basename(process.execPath).toLowerCase();
	const looksLikeGenericRuntime = /^(?:node|bun)(?:\.exe)?$/.test(execName);

	if (currentEntry && looksLikeGenericRuntime) {
		return { command: process.execPath, argsPrefix: [resolve(currentEntry)] };
	}
	if (!looksLikeGenericRuntime) {
		return { command: process.execPath, argsPrefix: [] };
	}
	return { command: "pi", argsPrefix: [] };
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => typeof part === "object" && part !== null && (part as any).type === "text")
		.map((part) => String((part as any).text ?? ""))
		.join("")
		.trim();
}

function runtimePaths(projectRoot: string): RuntimePaths {
	const runtimeDir = join(projectRoot, ".pi", "magic-docs");
	return {
		projectRoot,
		runtimeDir,
		statePath: join(runtimeDir, "state.json"),
		lockPath: join(runtimeDir, "update.lock"),
		requestPath: join(runtimeDir, "latest-request.json"),
		resultPath: join(runtimeDir, "latest-result.json"),
		logPath: join(runtimeDir, "updater.log"),
		sessionPath: join(runtimeDir, "updater-session.jsonl"),
		launchScriptPath: join(runtimeDir, "launch-updater.sh"),
		systemPromptPath: join(runtimeDir, "updater-system-prompt.md"),
	};
}

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd?: string) {
	const result = await pi.exec(command, args, { cwd, timeout: 10_000 });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1 };
}

async function resolveProjectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const git = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
	const candidate = git.code === 0 && git.stdout.trim() ? git.stdout.trim() : cwd;
	try {
		return await fsp.realpath(candidate);
	} catch {
		return resolve(candidate);
	}
}

async function detectFingerprint(path: string): Promise<DocFingerprint | undefined> {
	try {
		const stat = await fsp.stat(path);
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}

function validateState(value: unknown, path: string): MagicDocsState {
	if (typeof value !== "object" || value === null) throw new Error(`${path} must contain a JSON object.`);
	const state = value as Record<string, unknown>;
	if (state.lastJudgeAt !== undefined && typeof state.lastJudgeAt !== "string") {
		throw new Error(`${path}: lastJudgeAt must be a string when present.`);
	}
	if (state.lastNotifiedResultRequestId !== undefined && typeof state.lastNotifiedResultRequestId !== "string") {
		throw new Error(`${path}: lastNotifiedResultRequestId must be a string when present.`);
	}
	return {
		lastJudgeAt: typeof state.lastJudgeAt === "string" ? state.lastJudgeAt : undefined,
		lastNotifiedResultRequestId: typeof state.lastNotifiedResultRequestId === "string" ? state.lastNotifiedResultRequestId : undefined,
	};
}

function validateLock(value: unknown, path: string): MagicDocsLock {
	if (typeof value !== "object" || value === null) throw new Error(`${path} must contain a JSON object.`);
	const lock = value as Record<string, unknown>;
	if (typeof lock.requestId !== "string" || !lock.requestId.trim()) throw new Error(`${path}: requestId must be a non-empty string.`);
	if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error(`${path}: pid must be a positive integer.`);
	if (typeof lock.startedAt !== "string" || !lock.startedAt.trim()) throw new Error(`${path}: startedAt must be a non-empty string.`);
	if (typeof lock.projectRoot !== "string" || !lock.projectRoot.trim()) throw new Error(`${path}: projectRoot must be a non-empty string.`);
	if (typeof lock.sessionFile !== "string" || !lock.sessionFile.trim()) throw new Error(`${path}: sessionFile must be a non-empty string.`);
	return {
		requestId: lock.requestId,
		pid: lock.pid,
		startedAt: lock.startedAt,
		projectRoot: lock.projectRoot,
		sessionFile: lock.sessionFile,
	};
}

function validateResult(value: unknown, path: string): MagicDocsUpdateResult {
	if (typeof value !== "object" || value === null) throw new Error(`${path} must contain a JSON object.`);
	const result = value as Record<string, unknown>;
	if (result.version !== UPDATE_REQUEST_VERSION) throw new Error(`${path}: unsupported version ${String(result.version)}.`);
	if (typeof result.requestId !== "string" || !result.requestId.trim()) throw new Error(`${path}: requestId must be a non-empty string.`);
	if (typeof result.completedAt !== "string" || !result.completedAt.trim()) throw new Error(`${path}: completedAt must be a non-empty string.`);
	if (result.status !== "completed" && result.status !== "failed") throw new Error(`${path}: status must be 'completed' or 'failed'.`);
	if (!Array.isArray(result.changed) || !result.changed.every((entry) => typeof entry === "string")) throw new Error(`${path}: changed must be a string array.`);
	if (!Array.isArray(result.unchanged) || !result.unchanged.every((entry) => typeof entry === "string")) throw new Error(`${path}: unchanged must be a string array.`);
	if (!Array.isArray(result.skipped)) throw new Error(`${path}: skipped must be an array.`);
	const skipped = result.skipped.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`${path}: skipped[${index}] must be an object.`);
		const item = entry as Record<string, unknown>;
		if (typeof item.path !== "string" || !item.path.trim()) throw new Error(`${path}: skipped[${index}].path must be a non-empty string.`);
		if (typeof item.reason !== "string" || !item.reason.trim()) throw new Error(`${path}: skipped[${index}].reason must be a non-empty string.`);
		return { path: item.path, reason: item.reason };
	});
	if (result.error !== undefined && typeof result.error !== "string") throw new Error(`${path}: error must be a string when present.`);
	return {
		version: UPDATE_REQUEST_VERSION,
		requestId: result.requestId,
		completedAt: result.completedAt,
		status: result.status,
		changed: result.changed as string[],
		unchanged: result.unchanged as string[],
		skipped,
		...(typeof result.error === "string" ? { error: result.error } : {}),
	};
}

async function readJsonFile<T>(path: string, validate: (value: unknown, path: string) => T): Promise<T | undefined> {
	let raw: string;
	try {
		raw = await fsp.readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		throw new Error(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validate(parsed, path);
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await fsp.mkdir(dirname(path), { recursive: true });
	await fsp.writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function removeFileIfExists(path: string): Promise<void> {
	try {
		await fsp.unlink(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw new Error(`Failed to remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

async function pruneTrackedDocs(tracked: Map<string, TrackedDoc>): Promise<void> {
	for (const [path] of tracked) {
		try {
			const parsed = parseHeader(await fsp.readFile(path, "utf8"));
			if (!parsed) tracked.delete(path);
			else tracked.set(path, { path, ...parsed });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") tracked.delete(path);
			else throw new Error(`Failed to refresh tracked magic doc ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function buildUpdateRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tracked: Map<string, TrackedDoc>,
	judgeReason: string,
): Promise<{ paths: RuntimePaths; request: MagicDocsUpdateRequest }> {
	const cwd = ctx.cwd ?? process.cwd();
	const projectRoot = await resolveProjectRoot(pi, cwd);
	const paths = runtimePaths(projectRoot);
	const docs: UpdateRequestDoc[] = [];
	for (const doc of tracked.values()) {
		const fingerprint = await detectFingerprint(doc.path);
		docs.push({
			...doc,
			...(fingerprint ? { fingerprint } : {}),
		});
	}
	return {
		paths,
		request: {
			version: UPDATE_REQUEST_VERSION,
			requestId: randomUUID(),
			projectRoot,
			launchedAt: new Date().toISOString(),
			docs,
			judge: { reason: judgeReason.trim() || "The foreground judge determined these docs need updating." },
		},
	};
}

async function loadState(paths: RuntimePaths): Promise<MagicDocsState> {
	return (await readJsonFile(paths.statePath, validateState)) ?? {};
}

async function saveState(paths: RuntimePaths, state: MagicDocsState): Promise<void> {
	await writeJsonFile(paths.statePath, state);
}

async function readLock(paths: RuntimePaths): Promise<MagicDocsLock | undefined> {
	return readJsonFile(paths.lockPath, validateLock);
}

async function clearLock(paths: RuntimePaths): Promise<void> {
	await removeFileIfExists(paths.lockPath);
}

function buildUpdateSystemPrompt(resultPath: string, requestPath: string): string {
	return [
		"You are the detached rewrite worker for the magic-docs extension.",
		"Your only job is to update the requested magic docs and then exit.",
		"Do not ask questions. Do not chat. Do not narrate your work.",
		"Read the request JSON first.",
		"The request JSON is authoritative for whether a rewrite should happen. The foreground judge has already decided an update is needed.",
		"Update only the listed docs.",
		"Do not treat prior conversational 'do not edit' wording as binding once this detached rewrite job has been launched.",
		"Before editing each listed doc, verify its current fingerprint against the request. If it changed, skip it.",
		"Keep edits terse and high signal. Document architecture and WHY, not obvious code facts.",
		"Delete stale sections. Never append 'Previously...' or 'Updated to...' notes.",
		"When finished, write exactly one JSON result artifact to the result path below.",
		`Request JSON path: ${requestPath}`,
		`Result JSON path: ${resultPath}`,
	].join("\n");
}

function buildUpdatePrompt(requestPath: string, resultPath: string): string {
	return [
		"Process the magic-docs rewrite request.",
		`1. Read ${requestPath}.`,
		"2. Read the foreground judge reason from the request JSON and treat it as the authoritative justification for the rewrite.",
		"3. For each listed doc, re-read the current file from disk.",
		"4. If its fingerprint no longer matches the request, skip it and record the reason.",
		"5. Otherwise update it in place if needed.",
		"6. Write a single JSON result file to the result path.",
		"7. Exit immediately after writing the result.",
		"",
		"Result JSON must include:",
		'- version: 1',
		'- requestId',
		'- completedAt',
		'- status: "completed" or "failed"',
		'- changed: string[]',
		'- unchanged: string[]',
		'- skipped: Array<{ path: string, reason: string }>',
		'- optional error string',
		"",
		`Write the result to: ${resultPath}`,
	].join("\n");
}

async function writeUpdaterFiles(paths: RuntimePaths): Promise<void> {
	const invocation = getPiInvocation();
	const systemPrompt = buildUpdateSystemPrompt(paths.resultPath, paths.requestPath);
	const prompt = buildUpdatePrompt(paths.requestPath, paths.resultPath);
	const args = [
		...invocation.argsPrefix,
		"--print",
		"--session",
		paths.sessionPath,
		"--model",
		`${JUDGE_MODEL_PROVIDER}/${JUDGE_MODEL_ID}`,
		"--thinking",
		"off",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--append-system-prompt",
		paths.systemPromptPath,
		prompt,
	];
	const script = [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		`cd ${shellQuote(paths.projectRoot)}`,
		`exec env PI_MAGIC_DOCS_BACKGROUND_REWRITE=1 ${shellQuote(invocation.command)} ${args.map(shellQuote).join(" ")}`,
		"",
	].join("\n");
	await fsp.mkdir(paths.runtimeDir, { recursive: true });
	await fsp.writeFile(paths.systemPromptPath, systemPrompt, "utf8");
	await fsp.writeFile(paths.launchScriptPath, script, { encoding: "utf8", mode: 0o755 });
	await fsp.chmod(paths.launchScriptPath, 0o755);
}

function formatRewriteNotification(result: MagicDocsUpdateResult): string {
	if (result.status === "failed") {
		return `Magic docs update failed: ${result.error ?? "background rewrite did not complete successfully."}`;
	}
	const parts = [`${result.changed.length} changed`, `${result.unchanged.length} unchanged`];
	if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
	return `Magic docs updated: ${parts.join(", ")}.`;
}

async function maybeNotifyRewriteResult(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const cwd = ctx.cwd ?? process.cwd();
	const projectRoot = await resolveProjectRoot(pi, cwd);
	const paths = runtimePaths(projectRoot);
	const state = await loadState(paths);
	const lock = await readLock(paths);
	const result = await readJsonFile(paths.resultPath, validateResult);

	if (result && state.lastNotifiedResultRequestId !== result.requestId) {
		if (ctx.hasUI) ctx.ui.notify(formatRewriteNotification(result), result.status === "failed" ? "error" : "info");
		await saveState(paths, { ...state, lastNotifiedResultRequestId: result.requestId });
		if (lock?.requestId === result.requestId) await clearLock(paths);
		return;
	}

	if (!lock) return;
	if (isPidAlive(lock.pid)) return;
	const startedAtMs = Date.parse(lock.startedAt);
	if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < RESULT_GRACE_MS) return;

	if (ctx.hasUI) {
		ctx.ui.notify("Magic docs update failed: detached rewrite exited without writing a result.", "error");
	}
	await clearLock(paths);
	await saveState(paths, { ...state, lastNotifiedResultRequestId: lock.requestId });
}

async function checkWithHaiku(
	docs: TrackedDoc[],
	recentMessages: any[],
	apiKey: string,
): Promise<{ shouldUpdate: boolean; reason: string }> {
	const model = getModel(JUDGE_MODEL_PROVIDER, JUDGE_MODEL_ID);
	if (!model) return { shouldUpdate: false, reason: "model not found" };

	try {
		const docList = docs.map((doc) => `- "${doc.title}" (${doc.path})`).join("\n");
		const conversationText = serializeConversation(convertToLlm(recentMessages));
		const response = await complete(
			model,
			{
				systemPrompt:
					"You decide whether documentation needs updating based on a conversation. " +
					"You MUST call the report_decision tool. Do not write text responses.",
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text:
									`Do these docs need updating based on the conversation?\n\n` +
									`Tracked docs:\n${docList}\n\n` +
									`Conversation:\n${conversationText}\n\n` +
									`Update if there are new decisions, architecture changes, features, or corrections relevant to these specific docs. ` +
									`Skip for small talk, unrelated topics, or no new information.`,
							},
						],
						timestamp: Date.now(),
					},
				],
				tools: [REPORT_TOOL],
			},
			{ apiKey },
		);

		const toolCall = response.content.find((entry: any) => entry.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") {
			return { shouldUpdate: false, reason: "no tool call" };
		}
		return {
			shouldUpdate: toolCall.arguments.should_update,
			reason: toolCall.arguments.reason,
		};
	} catch (error) {
		return { shouldUpdate: false, reason: `error: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function launchBackgroundRewrite(pi: ExtensionAPI, ctx: ExtensionContext, paths: RuntimePaths, request: MagicDocsUpdateRequest): Promise<void> {
	const lock = await readLock(paths);
	if (lock && isPidAlive(lock.pid)) return;
	if (lock) await clearLock(paths);

	await fsp.mkdir(paths.runtimeDir, { recursive: true });
	await writeUpdaterFiles(paths);
	await removeFileIfExists(paths.resultPath);
	await writeJsonFile(paths.requestPath, request);

	const command = `cd ${shellQuote(paths.projectRoot)} && nohup bash ${shellQuote(paths.launchScriptPath)} >> ${shellQuote(paths.logPath)} 2>&1 < /dev/null & echo $!`;
	const launched = await pi.exec("bash", ["-lc", command], { cwd: paths.projectRoot, timeout: 10_000 });
	const pidText = String(launched.stdout ?? "").trim().split(/\s+/).at(-1) ?? "";
	const pid = Number.parseInt(pidText, 10);
	if ((launched.code ?? 1) !== 0 || !Number.isInteger(pid) || pid <= 0) {
		throw new Error((launched.stderr ?? launched.stdout ?? "").trim() || "Failed to launch detached magic-docs rewrite job.");
	}

	await writeJsonFile(paths.lockPath, {
		requestId: request.requestId,
		pid,
		startedAt: request.launchedAt,
		projectRoot: paths.projectRoot,
		sessionFile: paths.sessionPath,
	} satisfies MagicDocsLock);
}

export default function (pi: ExtensionAPI) {
	const tracked = new Map<string, TrackedDoc>();
	let agentRunHadToolCalls = false;
	let consecutiveIdleRuns = 0;

	function detect(filePath: string, content: string) {
		const parsed = parseHeader(content);
		if (!parsed) return;
		tracked.set(filePath, { path: filePath, ...parsed });
	}

	function detectFromDisk(filePath: string) {
		try {
			detect(filePath, fs.readFileSync(filePath, "utf-8"));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				console.warn(`[magic-docs] Failed to read ${filePath}: ${error}`);
			}
		}
	}

	async function maybeJudgeAndLaunchRewrite(ctx: ExtensionContext) {
		if (tracked.size === 0) return;

		await pruneTrackedDocs(tracked);
		if (tracked.size === 0) return;

		const cwd = ctx.cwd ?? process.cwd();
		const projectRoot = await resolveProjectRoot(pi, cwd);
		const paths = runtimePaths(projectRoot);
		const state = await loadState(paths);
		const lastJudgeAtMs = state.lastJudgeAt ? Date.parse(state.lastJudgeAt) : 0;
		if (Number.isFinite(lastJudgeAtMs) && Date.now() - lastJudgeAtMs < JUDGE_COOLDOWN_MS) return;

		const lock = await readLock(paths);
		if (lock && isPidAlive(lock.pid)) return;
		if (lock) await clearLock(paths);

		const judgeModel = getModel(JUDGE_MODEL_PROVIDER, JUDGE_MODEL_ID);
		if (!judgeModel) return;
		const auth = await (ctx.modelRegistry as any).getApiKeyAndHeaders(judgeModel);
		if (!auth.ok || !auth.apiKey) return;

		const recentMessages = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => (entry as any).message)
			.slice(-JUDGE_RECENT_MESSAGES);
		const docs = Array.from(tracked.values());
		const { shouldUpdate, reason } = await checkWithHaiku(docs, recentMessages, auth.apiKey);
		await saveState(paths, { ...state, lastJudgeAt: new Date().toISOString() });
		if (!shouldUpdate) return;

		const { request } = await buildUpdateRequest(pi, ctx, tracked, reason);
		await launchBackgroundRewrite(pi, ctx, paths, request);
	}

	pi.on("tool_result", async (event) => {
		const input = (event as any).input;
		if (event.toolName === "read") {
			const text = textFrom(event.content);
			if (input?.path && text) detect(input.path, text);
		} else if (event.toolName === "edit" || event.toolName === "write") {
			if (input?.path) detectFromDisk(input.path);
		}
	});

	pi.on("agent_start", async () => {
		agentRunHadToolCalls = false;
	});

	pi.on("turn_end", async (event) => {
		if (((event as any).toolResults?.length ?? 0) > 0) {
			agentRunHadToolCalls = true;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		try {
			await maybeNotifyRewriteResult(pi, ctx);
		} catch (error) {
			ctx.hasUI && ctx.ui.notify(`Magic docs status check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (process.env.PI_MAGIC_DOCS_BACKGROUND_REWRITE === "1") return;
		if (tracked.size === 0) return;

		if (agentRunHadToolCalls) {
			consecutiveIdleRuns = 0;
			return;
		}

		consecutiveIdleRuns++;
		if (consecutiveIdleRuns < JUDGE_IDLE_RUN_THRESHOLD) return;
		try {
			await maybeJudgeAndLaunchRewrite(ctx);
		} catch (error) {
			ctx.hasUI && ctx.ui.notify(`Magic docs autoupdate failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			consecutiveIdleRuns = 0;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		tracked.clear();
		agentRunHadToolCalls = false;
		consecutiveIdleRuns = 0;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message as any;
			if (msg.role !== "toolResult") continue;
			if (msg.toolName === "read") {
				const text = textFrom(msg.content);
				if (msg.input?.path && text) detect(msg.input.path, text);
			} else if (msg.toolName === "edit" || msg.toolName === "write") {
				if (msg.input?.path) detectFromDisk(msg.input.path);
			}
		}

		try {
			await maybeNotifyRewriteResult(pi, ctx);
		} catch (error) {
			ctx.hasUI && ctx.ui.notify(`Magic docs status check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (tracked.size === 0) return;

		const list = Array.from(tracked.values())
			.map((doc) => `  - ${doc.path} ("${doc.title}")`)
			.join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Magic Docs\n\nYou are tracking living documents (files starting with \`# MAGIC DOC:\`). ` +
				`Currently tracking:\n${list}\n\n` +
				`The extension may judge whether they need background maintenance and rewrite them outside the main session. ` +
				`When the user explicitly asks to update them in the current session: re-read, edit in-place, be terse, delete stale sections. Never narrate changes.`,
		};
	});
}
