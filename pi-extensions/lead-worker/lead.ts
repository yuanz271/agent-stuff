/**
 * Lead role — /lead and /worker commands + socket client + worker tool.
 *
 * The lead is any Pi session where the user runs /lead <repo-path>.
 * On activation:
 *   1. Creates <repo>/.pi/ if absent
 *   2. Switches to <repo>/.pi/lead.jsonl via ctx.switchSession
 *   3. Connects to or spawns the worker
 *   4. Queries worker status
 *
 * Incoming worker messages are injected into the lead conversation via
 * pi.sendMessage({ triggerTurn: true }) so the lead agent sees and acts on them.
 *
 * Auto-respawns the worker on unexpected socket close.
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { writeMessage, createMessageReader, type Message } from "./framing.js";

const TIMEOUT_MS = 10 * 60 * 1000;
const SPAWN_POLL_INTERVAL_MS = 200;
const SPAWN_TIMEOUT_MS = 10_000;

interface PendingCall {
	resolve: (payload: string) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

function expandTilde(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function pollForSocket(sockPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + SPAWN_TIMEOUT_MS;
		const check = () => {
			if (fs.existsSync(sockPath)) return resolve();
			if (Date.now() > deadline) {
				return reject(new Error(`Worker socket did not appear within ${SPAWN_TIMEOUT_MS}ms`));
			}
			setTimeout(check, SPAWN_POLL_INTERVAL_MS);
		};
		check();
	});
}

export function setupLead(pi: ExtensionAPI): void {
	let socket: net.Socket | null = null;
	let activeRepoPath: string | null = null;
	let isLeadInitiated = false; // true when the lead intentionally closes the socket
	let currentCtx: ExtensionContext | null = null;
	const pending = new Map<string, PendingCall>();

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	pi.on("session_shutdown", async () => {
		isLeadInitiated = true;
		rejectPending(new Error("Lead shutting down"));
		socket?.destroy();
		socket = null;
	});

	function sendToWorker(msg: Message): void {
		if (!socket || socket.destroyed) return;
		writeMessage(socket, msg);
	}

	function rejectPending(err: Error): void {
		for (const [, call] of pending) {
			clearTimeout(call.timer);
			call.reject(err);
		}
		pending.clear();
	}

	function handleMessage(msg: Message): void {
		if (msg.type === "reply") {
			const call = pending.get(msg.replyTo!);
			if (call) {
				clearTimeout(call.timer);
				pending.delete(msg.replyTo!);
				call.resolve(msg.payload);
			}
			return;
		}

		if (msg.type === "request") {
			// Inject into lead conversation so the lead agent sees and can respond
			const hint = `\n\n[To reply: worker({ action: "reply", replyTo: "${msg.id}", message: "..." })]`;
			pi.sendMessage(
				{
					customType: "lead-worker-request",
					content: `📨 From worker: ${msg.payload}${hint}`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
	}

	function attachSocket(sock: net.Socket, repoPath: string): void {
		socket = sock;
		activeRepoPath = repoPath;
		sock.on("data", createMessageReader(handleMessage));
		sock.on("close", () => {
			if (socket !== sock) return; // already replaced
			socket = null;
			if (isLeadInitiated) return; // intentional disconnect

			// Unexpected close — auto-respawn
			rejectPending(new Error("Worker disconnected unexpectedly"));
			currentCtx?.ui.notify("Worker crashed, respawning...", "warning");
			setTimeout(async () => {
				const sockPath = path.join(repoPath, ".pi", "worker.sock");
				try {
					await spawnWorker(sockPath, repoPath);
					currentCtx?.ui.notify("Worker respawned.", "info");
				} catch (err) {
					currentCtx?.ui.notify(`Failed to respawn worker: ${err}`, "warning");
				}
			}, 500);
		});
		sock.on("error", () => sock.destroy());
	}

	function connectToWorker(sockPath: string, repoPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const sock = net.createConnection(sockPath, () => {
				attachSocket(sock, repoPath);
				resolve();
			});
			sock.once("error", reject);
		});
	}

	async function spawnWorker(sockPath: string, repoPath: string): Promise<void> {
		// Clean up stale socket from previous crash
		if (fs.existsSync(sockPath)) {
			try { fs.unlinkSync(sockPath); } catch { /* best-effort */ }
		}

		spawn("pi", ["--session", path.join(repoPath, ".pi", "worker.jsonl")], {
			cwd: repoPath,
			detached: true,
			stdio: "ignore",
		}).unref();

		await pollForSocket(sockPath);
		await connectToWorker(sockPath, repoPath);
	}

	// ── /lead command ─────────────────────────────────────────────────────────

	pi.registerCommand("lead", {
		description: "Activate lead mode for a repo: /lead <repo-path>",
		handler: async (args, ctx) => {
			const rawPath = args.trim();
			if (!rawPath) {
				ctx.ui.notify("Usage: /lead <repo-path>", "warning");
				return;
			}

			const repoPath = path.resolve(expandTilde(rawPath));
			if (!fs.existsSync(repoPath)) {
				ctx.ui.notify(`Path does not exist: ${repoPath}`, "warning");
				return;
			}

			// Close previous connection if switching repos
			if (socket && activeRepoPath !== repoPath) {
				isLeadInitiated = true;
				socket.destroy();
				socket = null;
				isLeadInitiated = false;
			}

			// Ensure .pi/ directory exists — Pi does not create parent dirs automatically
			const piDir = path.join(repoPath, ".pi");
			fs.mkdirSync(piDir, { recursive: true });

			// Switch lead session (creates lead.jsonl if absent, resumes if present)
			const result = await ctx.switchSession(path.join(piDir, "lead.jsonl"));
			if (result.cancelled) return;

			currentCtx = ctx;

			// Connect to running worker, or spawn a fresh one
			const sockPath = path.join(piDir, "worker.sock");
			try {
				await connectToWorker(sockPath, repoPath);
				ctx.ui.notify(`Connected to worker for ${repoPath}`, "info");
			} catch {
				try {
					ctx.ui.notify("Spawning worker...", "info");
					await spawnWorker(sockPath, repoPath);
					ctx.ui.notify(`Worker ready for ${repoPath}`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to start worker: ${err}`, "warning");
					return;
				}
			}

			// Query worker status to re-orient after connecting
			sendToWorker({
				id: randomUUID(),
				type: "request",
				payload: "What is your current status and what were you last working on?",
			});
		},
	});

	// ── /worker command ───────────────────────────────────────────────────────

	pi.registerCommand("worker", {
		description: "Send a command directly to the active worker: /worker <command>",
		handler: async (args, ctx) => {
			if (!socket || socket.destroyed) {
				ctx.ui.notify("No active worker — run /lead <path> first.", "warning");
				return;
			}
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /worker <command>", "warning");
				return;
			}
			sendToWorker({ id: randomUUID(), type: "command", payload: command });
			ctx.ui.notify(`Command sent to worker: ${command}`, "info");
		},
	});

	// ── worker tool ───────────────────────────────────────────────────────────

	pi.registerTool({
		name: "worker",
		label: "Worker",
		description:
			"Communicate with the active worker session.\n\n" +
			"ACTIONS:\n" +
			"- send: delegate a task (fire-and-forget — worker works autonomously)\n" +
			"- ask: send a message and block until the worker replies\n" +
			"- reply: respond to an incoming worker request (include the replyTo ID from the injected message)\n" +
			"- status: check connection state and active repo",
		promptSnippet: "worker — delegate tasks or query the active worker session",
		promptGuidelines: [
			"Use 'send' to delegate tasks. The worker works autonomously and will report back when done.",
			"Use 'ask' when you need the worker's current status or a specific answer before continuing.",
			"Use 'reply' to respond to incoming worker escalations (include the exact replyTo ID shown in the message).",
		],
		parameters: Type.Object({
			action: StringEnum(["send", "ask", "reply", "status"] as const, {
				description: "send: fire-and-forget; ask: blocking query; reply: respond to worker; status: connection info",
			}),
			message: Type.Optional(Type.String({ description: "Message content (required for send, ask, reply)" })),
			replyTo: Type.Optional(Type.String({ description: "Request ID to reply to (required for reply)" })),
		}),
		async execute(_toolCallId, params, signal) {
			const { action, message, replyTo } = params;

			if (action === "status") {
				const connected = socket !== null && !socket.destroyed;
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ connected, activeRepo: activeRepoPath, pendingCalls: pending.size }) }],
					details: { connected, activeRepo: activeRepoPath },
				};
			}

			if (!socket || socket.destroyed) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "No active worker. Use /lead <path> to connect." }],
					details: { error: "not connected" },
				};
			}

			if (action === "send") {
				if (!message) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "send requires message." }],
						details: { error: "missing message" },
					};
				}
				sendToWorker({ id: randomUUID(), type: "request", payload: message });
				return {
					content: [{ type: "text" as const, text: "Task sent to worker." }],
					details: { sent: true },
				};
			}

			if (action === "reply") {
				if (!replyTo || !message) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: "reply requires replyTo and message." }],
						details: { error: "missing params" },
					};
				}
				sendToWorker({ id: randomUUID(), type: "reply", replyTo, payload: message });
				return {
					content: [{ type: "text" as const, text: "Reply sent to worker." }],
					details: { sent: true },
				};
			}

			// ask — blocking
			if (!message) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "ask requires message." }],
					details: { error: "missing message" },
				};
			}

			const id = randomUUID();
			sendToWorker({ id, type: "request", payload: message });

			return new Promise<AgentToolResult<unknown>>((resolve: (r: any) => void) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					resolve({
						isError: true,
						content: [{ type: "text" as const, text: "Timeout waiting for worker reply." }],
						details: { error: "timeout" },
					});
				}, TIMEOUT_MS);

				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					pending.delete(id);
					resolve({
						isError: true,
						content: [{ type: "text" as const, text: "Aborted." }],
						details: { error: "aborted" },
					});
				}, { once: true });

				pending.set(id, {
					resolve: (payload) => {
						clearTimeout(timer);
						resolve({
							content: [{ type: "text" as const, text: payload }],
							details: { payload },
						});
					},
					reject: (err) => {
						clearTimeout(timer);
						resolve({
							isError: true,
							content: [{ type: "text" as const, text: err.message }],
							details: { error: err.message },
						});
					},
					timer,
				});
			});
		},
	});
}
