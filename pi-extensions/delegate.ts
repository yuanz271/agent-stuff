import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MESSAGE_TYPE = "delegate-task";

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

function stripTerminalControlSequences(text: string): string {
	if (!text) return text;
	let cleaned = text;
	// OSC sequences: ESC ] ... BEL or ESC ] ... ESC \\
	cleaned = cleaned.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
	// CSI sequences: ESC [ ... command
	cleaned = cleaned.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
	return cleaned;
}

function buildResultMessage(task: string, modelSpec: string, output: string, exitCode: number): string {
	return [
		`Delegate task (${exitCode === 0 ? "success" : "failed"})`,
		`Task: ${task}`,
		`Model: ${modelSpec}`,
		"",
		output || "(no output)",
	].join("\n");
}

function buildCommandArgs(modelSpec: string, activeTools: string[], task: string): string[] {
	const args = ["-p", "--no-session", "--models", modelSpec];
	if (activeTools.length > 0) {
		args.push("--tools", activeTools.join(","));
	}
	args.push(task);
	return args;
}

function startBackgroundRun(pi: ExtensionAPI, ctx: ExtensionContext, task: string, modelSpec: string, cmdArgs: string[]): { runId: string; outputPath: string } {
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const outDir = path.join(os.tmpdir(), "pi-delegate-tasks");
	fs.mkdirSync(outDir, { recursive: true });
	const outputPath = path.join(outDir, `${runId}.log`);

	const outFd = fs.openSync(outputPath, "a");
	const child = spawn("pi", cmdArgs, {
		cwd: ctx.cwd,
		detached: true,
		stdio: ["ignore", outFd, outFd],
	});
	fs.closeSync(outFd);

	child.on("close", (code) => {
		const exitCode = code ?? 1;
		const status = exitCode === 0 ? "success" : "failed";
		const message = [
			`Delegate task finished (${status})`,
			`Task ID: ${runId}`,
			`Task: ${task}`,
			`Model: ${modelSpec}`,
			`Exit code: ${exitCode}`,
			`Output log: ${outputPath}`,
		].join("\n");

		try {
			ctx.ui.notify(`Delegated task ${runId} finished (${status})`, exitCode === 0 ? "info" : "warning");
		} catch {}

		pi.events.emit("delegate:complete", {
			runId,
			task,
			model: modelSpec,
			exitCode,
			outputPath,
		});
		pi.events.emit("delegate:task_complete", {
			runId,
			task,
			model: modelSpec,
			exitCode,
			outputPath,
		});

		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: message,
				display: true,
				details: {
					runId,
					task,
					model: modelSpec,
					exitCode,
					outputPath,
					background: true,
					finished: true,
				},
			},
			{ triggerTurn: false },
		);
	});

	child.unref();
	return { runId, outputPath };
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

			const cmdArgs = buildCommandArgs(modelSpec, pi.getActiveTools(), task);

			if (hasBgFlag) {
				const { runId, outputPath } = startBackgroundRun(pi, ctx, task, modelSpec, cmdArgs);
				ctx.ui.notify(`Delegated task started in background: ${runId}`, "info");
				pi.sendMessage(
					{
						customType: MESSAGE_TYPE,
						content: [
							"Delegate task queued (background)",
							`Task ID: ${runId}`,
							`Task: ${task}`,
							`Model: ${modelSpec}`,
							`Output log: ${outputPath}`,
							"",
							`Tail logs with: tail -f ${outputPath}`,
						].join("\n"),
						display: true,
						details: {
							runId,
							task,
							model: modelSpec,
							command: ["pi", ...cmdArgs].join(" "),
							outputPath,
							background: true,
						},
					},
					{ triggerTurn: false },
				);
				return;
			}

			ctx.ui.notify("Starting delegated task...", "info");
			const result = await pi.exec("pi", cmdArgs);
			const rawOutput = (result.stdout || result.stderr || "").trim();
			const output = stripTerminalControlSequences(rawOutput).trim();
			const exitCode = result.code ?? 1;

			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: buildResultMessage(task, modelSpec, output, exitCode),
					display: true,
					details: {
						task,
						model: modelSpec,
						exitCode,
						command: ["pi", ...cmdArgs].join(" "),
						background: false,
					},
				},
				{ triggerTurn: false },
			);
		},
	});
}
