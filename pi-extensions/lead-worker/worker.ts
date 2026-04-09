/**
 * Worker role — Unix socket server + lead tool.
 *
 * Activates only when the Pi session was started with
 * `pi --session <repo>/.pi/worker.jsonl` (i.e. spawned by the lead).
 *
 * The worker:
 * - Listens on <cwd>/.pi/worker.sock
 * - Injects incoming lead requests into the Pi conversation via pi.sendMessage
 * - Exposes a `lead` tool so the worker agent can ask/reply to the lead
 * - Handles `command` messages (model/thinking directives) without agent involvement
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { writeMessage, createMessageReader, type Message } from "./framing.js";

const TIMEOUT_MS = 10 * 60 * 1000;

interface PendingCall {
	resolve: (payload: string) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

export function setupWorker(pi: ExtensionAPI): void {
	let server: net.Server | null = null;
	let connection: net.Socket | null = null;
	let sockPath: string | null = null;
	let isWorkerSession = false;
	let sessionCtx: ExtensionContext | null = null;
	const pending = new Map<string, PendingCall>();

	function sendToLead(msg: Message): void {
		if (!connection || connection.destroyed) return;
		writeMessage(connection, msg);
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

		if (msg.type === "command") {
			// TODO: map known commands to Pi API calls (model switch, thinking level)
			sessionCtx?.ui.notify(`[worker] Command: ${msg.payload}`, "info");
			return;
		}

		if (msg.type === "request") {
			// Inject into worker conversation so the agent sees it and can respond
			const hint = `\n\n[To reply: lead({ action: "reply", replyTo: "${msg.id}", message: "..." })]`;
			pi.sendMessage(
				{
					customType: "lead-worker-request",
					content: `📨 From lead: ${msg.payload}${hint}`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
	}

	function handleConnection(socket: net.Socket): void {
		connection = socket;
		socket.on("data", createMessageReader(handleMessage));
		socket.on("close", () => {
			if (connection === socket) connection = null;
			// Reject any in-flight blocking calls immediately — don't wait for timeout
			rejectPending(new Error("Lead disconnected"));
		});
		socket.on("error", () => socket.destroy());
	}

	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
		if (!sessionFile.endsWith("/.pi/worker.jsonl")) return;

		isWorkerSession = true;
		sessionCtx = ctx;
		sockPath = path.join(path.dirname(sessionFile), "worker.sock");

		// Remove stale socket from a previous crash
		if (fs.existsSync(sockPath)) {
			try { fs.unlinkSync(sockPath); } catch { /* best-effort */ }
		}

		server = net.createServer(handleConnection);
		server.listen(sockPath, () => {
			ctx.ui.notify("Worker ready", "info");
		});
		server.on("error", (err) => {
			ctx.ui.notify(`Worker socket error: ${err.message}`, "warning");
		});
	});

	pi.on("session_shutdown", async () => {
		if (!isWorkerSession) return;
		rejectPending(new Error("Worker shutting down"));
		connection?.destroy();
		server?.close();
		if (sockPath) {
			try { fs.unlinkSync(sockPath); } catch { /* best-effort */ }
		}
	});

	// ── lead tool ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "lead",
		label: "Lead",
		description:
			"Communicate with the lead session.\n\n" +
			"ACTIONS:\n" +
			"- ask: send a message and block until the lead replies (use for escalations and completion reports)\n" +
			"- reply: respond to an incoming lead request (include the replyTo ID from the injected message)\n" +
			"- status: check connection state",
		promptSnippet: "lead — ask the lead a question or report completion (blocks until reply)",
		promptGuidelines: [
			"Use 'ask' when you need direction from the lead before continuing — for blockers, ambiguities, or completion reports.",
			"Use 'reply' to respond to a lead request shown in the conversation (include the exact replyTo ID).",
		],
		parameters: Type.Object({
			action: StringEnum(["ask", "reply", "status"] as const, {
				description: "ask: send and wait for reply; reply: respond to a lead request; status: connection info",
			}),
			message: Type.Optional(Type.String({ description: "Message content (required for ask and reply)" })),
			replyTo: Type.Optional(Type.String({ description: "Request ID to reply to (required for reply)" })),
		}),
		async execute(_toolCallId, params, signal) {
			const { action, message, replyTo } = params;

			if (action === "status") {
				const connected = connection !== null && !connection.destroyed;
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ connected, pendingCalls: pending.size }) }],
					details: { connected },
				};
			}

			if (!connection || connection.destroyed) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "Not connected to lead." }],
					details: { error: "not connected" },
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
				sendToLead({ id: randomUUID(), type: "reply", replyTo, payload: message });
				return {
					content: [{ type: "text" as const, text: "Reply sent." }],
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
			sendToLead({ id, type: "request", payload: message });

			return new Promise<AgentToolResult<unknown>>((resolve: (r: any) => void) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					resolve({
						isError: true,
						content: [{ type: "text" as const, text: "Timeout waiting for lead reply." }],
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
