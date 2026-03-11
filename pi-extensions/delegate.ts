import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MESSAGE_TYPE = "Delegate Task";
const OUTPUT_DIR = path.join(os.tmpdir(), "pi-delegate-tasks");
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

interface DelegateTaskMeta {
	taskId: string;
	task: string;
	model: string;
	pid?: number;
	status: "running" | "terminating" | "success" | "failed" | "killed";
	exitCode?: number;
	outputPath: string;
	startedAt: number;
	endedAt?: number;
}

interface DelegateResult {
	taskId: string;
	task: string;
	model: string;
	exitCode: number;
	status: "success" | "failed" | "killed";
	success: boolean;
	background: boolean;
	outputPath: string;
	output: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
}

function parseArgs(rawArgs: string): { task: string; hasBgFlag: boolean } {
	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
	let hasBgFlag = false;
	const taskTokens: string[] = [];

	for (const token of tokens) {
		if (token === "--bg") {
			hasBgFlag = true;
			continue;
		}
		taskTokens.push(token);
	}

	return { task: taskTokens.join(" ").trim(), hasBgFlag };
}

function buildModelSpec(ctx: ExtensionContext, pi: ExtensionAPI): string | null {
	const model = ctx.model;
	if (!model) return null;
	const thinking = pi.getThinkingLevel();
	const base = `${model.provider}/${model.id}`;
	if (!thinking || thinking === "off") return base;
	return `${base}:${thinking}`;
}

function newTaskId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureOutputDir(): void {
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function outputPathForTask(taskId: string): string {
	return path.join(OUTPUT_DIR, `${taskId}.log`);
}

function metaPathForTask(taskId: string): string {
	return path.join(OUTPUT_DIR, `${taskId}.json`);
}

function writeTaskMeta(meta: DelegateTaskMeta): void {
	try {
		fs.writeFileSync(metaPathForTask(meta.taskId), JSON.stringify(meta, null, 2), "utf-8");
	} catch {}
}

function readTaskMeta(taskId: string): DelegateTaskMeta | null {
	try {
		const raw = fs.readFileSync(metaPathForTask(taskId), "utf-8");
		return JSON.parse(raw) as DelegateTaskMeta;
	} catch {
		return null;
	}
}

function stripTerminalControlSequences(text: string): string {
	if (!text) return text;
	let cleaned = text;
	cleaned = cleaned.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
	cleaned = cleaned.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
	return cleaned;
}

function truncateOutput(text: string): { text: string; truncated: boolean; totalBytes: number; totalLines: number } {
	const normalized = text || "";
	const totalBytes = Buffer.byteLength(normalized, "utf8");
	const lines = normalized === "" ? [] : normalized.split("\n");
	const totalLines = lines.length;

	if (totalBytes <= MAX_OUTPUT_BYTES && totalLines <= MAX_OUTPUT_LINES) {
		return { text: normalized, truncated: false, totalBytes, totalLines };
	}

	const kept: string[] = [];
	let bytes = 0;
	for (let i = 0; i < lines.length; i++) {
		if (kept.length >= MAX_OUTPUT_LINES) break;
		const line = lines[i]!;
		const lineBytes = Buffer.byteLength(line, "utf8");
		const withNewline = kept.length > 0 ? 1 : 0;
		if (bytes + withNewline + lineBytes > MAX_OUTPUT_BYTES) break;
		if (withNewline) bytes += 1;
		bytes += lineBytes;
		kept.push(line);
	}

	return {
		text: kept.join("\n"),
		truncated: true,
		totalBytes,
		totalLines,
	};
}

function buildCommandArgs(modelSpec: string, activeTools: string[], task: string): string[] {
	const args = ["-p", "--no-session", "--models", modelSpec];
	const allowedTools = activeTools.filter((tool) => BUILTIN_TOOLS.has(tool));
	if (allowedTools.length > 0) {
		args.push("--tools", allowedTools.join(","));
	}
	args.push(task);
	return args;
}

function buildResultMessage(result: DelegateResult): string {
	const lines = [
		`Delegate task (${result.status})`,
		`Task ID: ${result.taskId}`,
		`Task: ${result.task}`,
		`Model: ${result.model}`,
		`Mode: ${result.background ? "background" : "foreground"}`,
		`Exit code: ${result.exitCode}`,
		`Output log: ${result.outputPath}`,
		"",
		result.output || "(no output)",
	];

	if (result.truncated) {
		lines.push(
			"",
			`[Output truncated: ${result.totalLines.toLocaleString()} lines, ${result.totalBytes.toLocaleString()} bytes. Full output in log file above.]`,
		);
	}

	return lines.join("\n");
}

function finalizeResult(params: {
	taskId: string;
	task: string;
	model: string;
	exitCode: number;
	background: boolean;
	outputPath: string;
	rawOutput: string;
	status?: "success" | "failed" | "killed";
}): DelegateResult {
	const cleaned = stripTerminalControlSequences(params.rawOutput).trim();
	const truncated = truncateOutput(cleaned);
	const status = params.status ?? (params.exitCode === 0 ? "success" : "failed");
	return {
		taskId: params.taskId,
		task: params.task,
		model: params.model,
		exitCode: params.exitCode,
		status,
		success: status === "success",
		background: params.background,
		outputPath: params.outputPath,
		output: truncated.text,
		truncated: truncated.truncated,
		totalBytes: truncated.totalBytes,
		totalLines: truncated.totalLines,
	};
}

function emitCompletion(pi: ExtensionAPI, ctx: ExtensionContext, result: DelegateResult): void {
	const level = result.status === "success" ? "info" : "warning";
	try {
		ctx.ui.notify(`Delegated task ${result.taskId} finished (${result.status})`, level);
	} catch {}

	pi.events.emit("delegate:complete", result);
	pi.events.emit("delegate:task_complete", result);

	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: buildResultMessage(result),
			display: true,
			details: result,
		},
		{ triggerTurn: false },
	);
}

function terminateTaskById(taskId: string): { ok: boolean; message: string; meta?: DelegateTaskMeta } {
	const meta = readTaskMeta(taskId);
	if (!meta) {
		return { ok: false, message: `Unknown task ID: ${taskId}` };
	}
	if (!meta.pid) {
		return { ok: false, message: `Task ${taskId} has no recorded PID.` };
	}
	if (meta.status !== "running" && meta.status !== "terminating") {
		return { ok: false, message: `Task ${taskId} is already ${meta.status}.`, meta };
	}

	try {
		meta.status = "terminating";
		writeTaskMeta(meta);
		try {
			process.kill(-meta.pid, "SIGTERM");
		} catch {
			process.kill(meta.pid, "SIGTERM");
		}
		return { ok: true, message: `Sent SIGTERM to task ${taskId} (pid ${meta.pid}).`, meta };
	} catch (error) {
		meta.status = "running";
		writeTaskMeta(meta);
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Failed to terminate task ${taskId}: ${detail}`, meta };
	}
}

function startBackgroundRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	taskId: string,
	task: string,
	modelSpec: string,
	cmdArgs: string[],
	outputPath: string,
): { pid?: number } {
	const outFd = fs.openSync(outputPath, "a");
	const child = spawn("pi", cmdArgs, {
		cwd: ctx.cwd,
		detached: true,
		stdio: ["ignore", outFd, outFd],
	});
	fs.closeSync(outFd);

	writeTaskMeta({
		taskId,
		task,
		model: modelSpec,
		pid: child.pid,
		status: "running",
		outputPath,
		startedAt: Date.now(),
	});

	child.on("close", (code, signal) => {
		const exitCode = code ?? 1;
		let rawOutput = "";
		try {
			rawOutput = fs.readFileSync(outputPath, "utf-8");
		} catch {}

		const previousMeta = readTaskMeta(taskId);
		const wasTerminating = previousMeta?.status === "terminating";
		const finalStatus: DelegateTaskMeta["status"] = wasTerminating || signal ? "killed" : exitCode === 0 ? "success" : "failed";
		writeTaskMeta({
			taskId,
			task,
			model: modelSpec,
			pid: child.pid,
			status: finalStatus,
			exitCode,
			outputPath,
			startedAt: previousMeta?.startedAt ?? Date.now(),
			endedAt: Date.now(),
		});

		const result = finalizeResult({
			taskId,
			task,
			model: modelSpec,
			exitCode,
			status: finalStatus,
			background: true,
			outputPath,
			rawOutput,
		});
		emitCompletion(pi, ctx, result);
	});

	child.unref();
	return { pid: child.pid };
}

export default function delegateExtension(pi: ExtensionAPI): void {
	pi.registerCommand("delegate", {
		description: "Delegate a task to an isolated child pi process using current model/tools",
		handler: async (args, ctx) => {
			const { task, hasBgFlag } = parseArgs(args);
			if (!task) {
				ctx.ui.notify("Usage: /delegate [--bg] <task>", "warning");
				return;
			}

			const modelSpec = buildModelSpec(ctx, pi);
			if (!modelSpec) {
				ctx.ui.notify("No active model selected.", "error");
				return;
			}

			ensureOutputDir();
			const taskId = newTaskId();
			const outputPath = outputPathForTask(taskId);
			const cmdArgs = buildCommandArgs(modelSpec, pi.getActiveTools(), task);

			if (hasBgFlag) {
				const { pid } = startBackgroundRun(pi, ctx, taskId, task, modelSpec, cmdArgs, outputPath);
				ctx.ui.notify(`Delegated task started in background: ${taskId}`, "info");
				pi.sendMessage(
					{
						customType: MESSAGE_TYPE,
						content: [
							"Delegate task queued (background)",
							`Task ID: ${taskId}`,
							`Task: ${task}`,
							`Model: ${modelSpec}`,
							`PID: ${pid ?? "unknown"}`,
							`Output log: ${outputPath}`,
							"",
							`Tail logs with: tail -f ${outputPath}`,
						].join("\n"),
						display: true,
						details: {
							taskId,
							task,
							model: modelSpec,
							pid,
							command: ["pi", ...cmdArgs].join(" "),
							outputPath,
							background: true,
							queued: true,
						},
					},
					{ triggerTurn: false },
				);
				return;
			}

			ctx.ui.notify("Starting delegated task...", "info");
			const result = await pi.exec("pi", cmdArgs);
			const rawOutput = (result.stdout || result.stderr || "").trim();
			fs.writeFileSync(outputPath, rawOutput, "utf-8");
			const final = finalizeResult({
				taskId,
				task,
				model: modelSpec,
				exitCode: result.code ?? 1,
				background: false,
				outputPath,
				rawOutput,
			});

			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: buildResultMessage(final),
					display: true,
					details: final,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("delegate-kill", {
		description: "Terminate a background delegated task by task ID",
		handler: async (args, ctx) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /delegate-kill <task-id>", "warning");
				return;
			}

			const result = terminateTaskById(taskId);
			ctx.ui.notify(result.message, result.ok ? "info" : "warning");
			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: [
						result.ok ? "Delegate task termination requested" : "Delegate task termination failed",
						`Task ID: ${taskId}`,
						result.message,
					].join("\n"),
					display: true,
					details: {
						taskId,
						ok: result.ok,
						message: result.message,
						status: result.meta?.status,
						pid: result.meta?.pid,
					},
				},
				{ triggerTurn: false },
			);
		},
	});
}
