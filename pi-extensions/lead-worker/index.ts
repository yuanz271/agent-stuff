import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getModel, StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMessage,
  createMessageReader,
  DEFAULT_REQUEST_TIMEOUT_MS,
  validateMessage,
  writeMessage,
  type PairMessageV2,
  type PairRole,
} from "./protocol.js";
import {
  getWorkerStatus,
  resolvePairRuntimePaths,
  resolveProjectRoot,
  startWorker,
  stopWorker,
  type WorkerStatus,
} from "./utils.js";
import {
  BUILD_HANDOFF_MESSAGE_TYPE,
  CONTEXT_MESSAGE_TYPE,
  MAX_HANDOFF_CHARS,
  MAX_TRACKED_REPORTED_HANDOFF_IDS,
  SOCKET_WAIT_INTERVAL_MS,
  SOCKET_WAIT_TIMEOUT_MS,
  SUPERVISOR_MODEL_ID,
  SUPERVISOR_MODEL_PROVIDER,
  TOOL_NAME,
  rt,
  currentPairRole,
  getLeadSessionBinding,
  getMessagesSinceLastUser,
  isTerminalSupervisionEvent,
  leadConfig,
  pairedRole,
  refreshSettings,
  truncate,
  type ActiveConnection,
  type ActiveSupervisedHandoff,
  type LeadWorkerControlAction,
  type PendingInboundRequest,
  type PendingRpc,
} from "./runtime.js";
import {
  emitInfo,
  formatLeadModel,
  formatStatusMarkdown,
  getCurrentLeadSelection,
  resolveCommandAction,
  restoreModeState,
  runControlAction,
  updateStatusLine,
} from "./control.js";
import {
  deliverIncomingProtocolMessage,
  formatWorkerStatusReply,
  inferWorkerEventName,
  maybeAutoReportWorkerCompletion,
  maybeRelayWorkerEventToUser,
  promptForReply,
  queryWorkerStatusPassive,
} from "./relay.js";
import {
  maybeRunLeadSupervision,
  resolveLeadSupervisionModel,
  synthesizeOutcome,
} from "./supervision.js";

const CORE_BLOCKED_BASH_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish|run\s+build)\b/i,
  /\byarn\s+(add|remove|install|publish|build)\b/i,
  /\bpnpm\s+(add|remove|install|publish|build)\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\buv\s+(add|remove|sync|pip\s+install)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|restore|clean|stash|cherry-pick|revert|apply|am|tag)\b/i,
  /\bsudo\b/i,
  /\bbash\b/i,
  /\bsh\b/i,
  /\bzsh\b/i,
];

function stripBenignRedirects(command: string): string {
  return command
    .replace(/(^|[\s;|&])(?:[12]?>\s*\/dev\/null)(?=$|[\s;|&])/gi, "$1")
    .replace(/(^|[\s;|&])(?:[12]?>&[12])(?=$|[\s;|&])/g, "$1");
}

function isSafeLeadBash(command: string): boolean {
  const commandForMutatingChecks = stripBenignRedirects(command);
  return !CORE_BLOCKED_BASH_PATTERNS.some((pattern) => pattern.test(commandForMutatingChecks));
}

function workerSessionReference(): string {
  return "the paired worker session";
}

function notify(ctx: ExtensionContext | undefined, message: string, severity: "info" | "warning" | "error" = "info"): void {
  if (ctx?.hasUI) ctx.ui.notify(message, severity);
}

function rememberExpiredRpc(id: string): void {
  rt.expiredRpcIds.add(id);
  if (rt.expiredRpcIds.size <= MAX_TRACKED_REPORTED_HANDOFF_IDS) return;
  const oldest = rt.expiredRpcIds.values().next().value;
  if (oldest) rt.expiredRpcIds.delete(oldest);
}

function clearPendingRpc(id: string): void {
  const pending = rt.pendingRpc.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  rt.pendingRpc.delete(id);
}

function rejectAllPendingRpc(reason: string): void {
  for (const [id, pending] of rt.pendingRpc.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    rt.pendingRpc.delete(id);
  }
}

function activeSocketForRole(role: PairRole): Socket | undefined {
  return role === "lead" ? rt.activeConnection?.socket : rt.activeLeadSocket;
}

function markPendingWorkerHandoffTerminalEvent(message: PairMessageV2): void {
  const pending = rt.pendingWorkerHandoff;
  if (!pending) return;
  if (message.from !== "worker" || message.type !== "event") return;
  if (!isTerminalSupervisionEvent(message.name ?? "")) return;
  if (message.handoffId !== pending.id) return;
  pending.terminalEventSentAtMs = Date.now();
}

function sendProtocolMessage(socket: Socket, message: PairMessageV2): void {
  writeMessage(socket, message);
  markPendingWorkerHandoffTerminalEvent(message);
}

async function resolveRuntimeContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<{
  role: PairRole;
  cwd: string;
  projectRoot: string;
  pairId: string;
  runtimeDir: string;
  protocolDir: string;
  socketPath: string;
}> {
  const cwd = ctx.cwd ?? process.cwd();
  const paths = await resolvePairRuntimePaths(pi, cwd);
  return {
    role: currentPairRole(),
    cwd,
    projectRoot: paths.projectRoot,
    pairId: paths.pairId,
    runtimeDir: paths.runtimeDir,
    protocolDir: paths.protocolDir,
    socketPath: paths.socketPath,
  };
}

function isRetryableWorkerSocketError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
}

async function waitForSocketConnect(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function connectToWorkerSocket(socketPath: string, timeoutMs = SOCKET_WAIT_TIMEOUT_MS): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    const socket = createConnection(socketPath);
    try {
      await waitForSocketConnect(socket);
      return socket;
    } catch (error) {
      socket.destroy();
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      if (!isRetryableWorkerSocketError(err) || Date.now() + SOCKET_WAIT_INTERVAL_MS >= deadline) {
        break;
      }
      await delay(SOCKET_WAIT_INTERVAL_MS);
    }
  }

  throw new Error(
    `Failed to connect to worker socket ${socketPath} within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : "."}`,
  );
}

function queuedWorkerEventsPath(protocolDir: string): string {
  return join(protocolDir, "pending-events.json");
}

function validateQueuedWorkerEvent(value: unknown): PairMessageV2 {
  const message = validateMessage(value);
  if (message.type !== "event") throw new Error(`Queued message ${message.id} must be an event.`);
  if (message.from !== "worker" || message.to !== "lead") {
    throw new Error(`Queued message ${message.id} must be worker→lead.`);
  }
  return message;
}

async function loadQueuedWorkerEvents(protocolDir: string): Promise<PairMessageV2[]> {
  const queuePath = queuedWorkerEventsPath(protocolDir);
  let raw: string;
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return [];
    throw new Error(`Failed to read queued worker events ${queuePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Queued worker events file ${queuePath} must contain a JSON array.`);
  }
  return parsed.map(validateQueuedWorkerEvent);
}

async function saveQueuedWorkerEvents(protocolDir: string, events: PairMessageV2[]): Promise<void> {
  const queuePath = queuedWorkerEventsPath(protocolDir);
  if (events.length === 0) {
    try {
      await fs.unlink(queuePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw new Error(`Failed to clear queued worker events ${queuePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return;
  }

  await fs.mkdir(protocolDir, { recursive: true });
  await fs.writeFile(queuePath, JSON.stringify(events, null, 2) + "\n", "utf8");
}

const workerEventQueueLocks = new Map<string, Promise<void>>();

function withQueueLock<T>(protocolDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = workerEventQueueLocks.get(protocolDir) ?? Promise.resolve();
  const next = prev.then(fn);
  const settled = next.then(
    () => { if (workerEventQueueLocks.get(protocolDir) === settled) workerEventQueueLocks.delete(protocolDir); },
    () => { if (workerEventQueueLocks.get(protocolDir) === settled) workerEventQueueLocks.delete(protocolDir); },
  );
  workerEventQueueLocks.set(protocolDir, settled);
  return next;
}

async function enqueueWorkerEvent(protocolDir: string, message: PairMessageV2): Promise<void> {
  await withQueueLock(protocolDir, async () => {
    const queued = await loadQueuedWorkerEvents(protocolDir);
    queued.push(message);
    await saveQueuedWorkerEvents(protocolDir, queued);
  });
  markPendingWorkerHandoffTerminalEvent(message);
}

async function flushQueuedWorkerEvents(protocolDir: string, socket: Socket, pairId: string): Promise<void> {
  await withQueueLock(protocolDir, async () => {
    const queued = await loadQueuedWorkerEvents(protocolDir);
    if (queued.length === 0) return;

    let sent = 0;
    try {
      for (const message of queued) {
        if (message.pairId !== pairId) {
          throw new Error(`Queued worker event ${message.id} has wrong pairId ${message.pairId}.`);
        }
        sendProtocolMessage(socket, message);
        sent++;
      }
    } catch (error) {
      await saveQueuedWorkerEvents(protocolDir, queued.slice(sent));
      throw error;
    }

    await saveQueuedWorkerEvents(protocolDir, []);
  });
}

async function deliverWorkerEvent(protocolDir: string, socket: Socket | undefined, message: PairMessageV2): Promise<boolean> {
  if (!socket || socket.destroyed) {
    await enqueueWorkerEvent(protocolDir, message);
    return true;
  }

  sendProtocolMessage(socket, message);
  return false;
}

function createAttachMessage(pairId: string, leadSessionId: string): PairMessageV2 {
  return createMessage({
    type: "command",
    from: "lead",
    to: "worker",
    pairId,
    name: "attach",
    payload: { leadSessionId },
    body: `Attach lead session ${leadSessionId}`,
  });
}

function onConnectionClosed(reason: string): void {
  rejectAllPendingRpc(reason);
  if (rt.activeConnection) {
    rt.activeConnection.socket.removeAllListeners();
  }
  rt.activeConnection = undefined;
  rt.connectionError = reason;
}

async function ensureLeadConnection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { autoStart: boolean; failIfUnavailable: boolean },
): Promise<ActiveConnection> {
  if (currentPairRole() !== "lead") {
    throw new Error("Only the lead session can initiate a worker socket connection.");
  }

  const { settings } = await refreshSettings(ctx.cwd ?? process.cwd());
  const leadSession = getLeadSessionBinding(ctx);
  let worker = await getWorkerStatus(pi, ctx.cwd ?? process.cwd(), settings, leadSession);
  if (!worker.running) {
    if (opts.autoStart) {
      worker = await startWorker(pi, ctx.cwd ?? process.cwd(), settings, leadSession);
      updateStatusLine(ctx, worker);
    } else {
      throw new Error(`Worker ${worker.agentName} is not running.`);
    }
  }

  const runtime = await resolveRuntimeContext(pi, ctx);
  if (
    rt.activeConnection &&
    rt.activeConnection.pairId === runtime.pairId &&
    !rt.activeConnection.socket.destroyed
  ) {
    return rt.activeConnection;
  }

  if (rt.connectPromise) return rt.connectPromise;

  rt.connectPromise = (async () => {
    const socket = await connectToWorkerSocket(runtime.socketPath);
    const connection: ActiveConnection = {
      socket,
      pairId: runtime.pairId,
      socketPath: runtime.socketPath,
      projectRoot: runtime.projectRoot,
      leadSessionId: leadSession.sessionId,
    };

    const reader = createMessageReader(
      (message) => {
        void handleIncomingMessage(pi, message).catch((error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          ctx.hasUI && ctx.ui.notify(`lead-worker protocol failed: ${err.message}`, "error");
          socket.destroy(err);
        });
      },
      (error) => {
        ctx.hasUI && ctx.ui.notify(`lead-worker protocol failed: ${error.message}`, "error");
        socket.destroy(error);
      },
    );

    socket.on("data", reader);
    socket.on("error", (error) => {
      rt.connectionError = error.message;
    });
    socket.on("close", () => {
      const reason = rt.connectionError ?? "Worker connection closed.";
      onConnectionClosed(reason);
    });

    rt.activeConnection = connection;
    rt.connectionError = undefined;

    try {
      const attachReply = await startRpc(createAttachMessage(runtime.pairId, leadSession.sessionId), socket);
      if (!attachReply.ok) {
        throw new Error(attachReply.error ?? attachReply.body ?? "Failed to attach lead connection.");
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      socket.destroy(err);
      throw err;
    }

    return connection;
  })();

  try {
    return await rt.connectPromise;
  } finally {
    rt.connectPromise = undefined;
  }
}

function startRpc(message: PairMessageV2, socket: Socket, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PairMessageV2> {
  return new Promise<PairMessageV2>((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pendingRpc.delete(message.id);
      rememberExpiredRpc(message.id);
      reject(new Error(`${message.type} '${message.name ?? message.id}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    rt.pendingRpc.set(message.id, { resolve, reject, timer });
    try {
      sendProtocolMessage(socket, message);
    } catch (error) {
      clearPendingRpc(message.id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}


async function maybePrimeLeadConnection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (currentPairRole() !== "lead") return;
  await ensureLeadConnection(pi, ctx, { autoStart: false, failIfUnavailable: false }).catch(() => undefined);
}

function registerInboundRequest(message: PairMessageV2): void {
  rt.pendingInboundRequests.set(message.id, {
    from: message.from,
    name: message.name,
    receivedAtMs: Date.now(),
  });
}

function clearInboundRequest(replyTo: string): void {
  rt.pendingInboundRequests.delete(replyTo);
}

async function resolveModelSelection(ctx: ExtensionContext, ref: string) {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("model reference is required");
  const explicit = trimmed.includes("/") ? trimmed : undefined;
  if (explicit) {
    const [provider, modelId] = explicit.split("/", 2);
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model ${explicit} is not available in the local registry.`);
    return model;
  }

  const matches = ctx.modelRegistry.getAll().filter((model) => model.id === trimmed);
  if (matches.length === 0) throw new Error(`Model ${trimmed} is not available in the local registry.`);
  if (matches.length > 1) throw new Error(`Model id '${trimmed}' is ambiguous. Use provider/model-id.`);
  return matches[0];
}

async function handleWorkerCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
  sourceSocket?: Socket,
): Promise<PairMessageV2> {
  const name = message.name ?? "";
  if (name === "attach") {
    if (!sourceSocket) throw new Error("attach requires a source socket.");
    const payload = typeof message.payload === "object" && message.payload !== null ? (message.payload as Record<string, unknown>) : {};
    const leadSessionId = typeof payload.leadSessionId === "string" && payload.leadSessionId.trim() ? payload.leadSessionId.trim() : "";
    if (!leadSessionId) throw new Error("attach requires leadSessionId.");

    const currentSocket = rt.activeLeadSocket;
    const currentLeadSessionId = rt.activeLeadSessionId;
    if (currentSocket && currentSocket !== sourceSocket && !currentSocket.destroyed) {
      if (currentLeadSessionId !== leadSessionId) {
        throw new Error("worker is already attached to another active lead connection");
      }
      rt.activeLeadSocket = sourceSocket;
      rt.activeLeadSessionId = leadSessionId;
      currentSocket.destroy(new Error("Superseded by reconnect from same lead session."));
    } else {
      rt.activeLeadSocket = sourceSocket;
      rt.activeLeadSessionId = leadSessionId;
    }

    return createMessage({
      type: "reply",
      from: "worker",
      to: "lead",
      pairId: message.pairId,
      replyTo: message.id,
      ok: true,
      body: `Attached lead session ${leadSessionId}.`,
      payload: { leadSessionId },
    });
  }
  if (name === "status") {
    return createMessage({
      type: "reply",
      from: "worker",
      to: "lead",
      pairId: message.pairId,
      replyTo: message.id,
      ok: true,
      body: formatWorkerStatusReply(pi, ctx),
      payload: { pendingHandoffId: rt.pendingWorkerHandoff?.id },
    });
  }

  if (name === "interrupt") {
    await ctx.abort();
    return createMessage({
      type: "reply",
      from: "worker",
      to: "lead",
      pairId: message.pairId,
      replyTo: message.id,
      ok: true,
      body: "Worker interrupt requested.",
    });
  }

  if (name === "thinking") {
    const level = typeof message.payload === "object" && message.payload !== null && "level" in (message.payload as Record<string, unknown>)
      ? String((message.payload as Record<string, unknown>).level)
      : (message.body ?? "").trim();
    if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
      throw new Error(`Invalid thinking level '${level}'.`);
    }
    pi.setThinkingLevel(level as ThinkingLevel);
    return createMessage({
      type: "reply",
      from: "worker",
      to: "lead",
      pairId: message.pairId,
      replyTo: message.id,
      ok: true,
      body: `Worker thinking level set to ${level}.`,
    });
  }

  if (name === "model") {
    const ref = typeof message.payload === "object" && message.payload !== null && "ref" in (message.payload as Record<string, unknown>)
      ? String((message.payload as Record<string, unknown>).ref)
      : (message.body ?? "").trim();
    const model = await resolveModelSelection(ctx, ref);
    const ok = await pi.setModel(model);
    if (!ok) throw new Error(`No API key available for ${model.provider}/${model.id}.`);
    return createMessage({
      type: "reply",
      from: "worker",
      to: "lead",
      pairId: message.pairId,
      replyTo: message.id,
      ok: true,
      body: `Worker model set to ${model.provider}/${model.id}.`,
    });
  }

  if (name === "handoff") {
    const payload = typeof message.payload === "object" && message.payload !== null ? (message.payload as Record<string, unknown>) : {};
    const handoffId = typeof payload.handoffId === "string" && payload.handoffId.trim() ? payload.handoffId : message.handoffId;
    const handoffText = typeof payload.text === "string" && payload.text.trim() ? payload.text : (message.body ?? "").trim();
    if (!handoffId) throw new Error("handoffId is required for worker handoff command.");
    if (!handoffText) throw new Error("handoff text is required for worker handoff command.");

    rt.pendingWorkerHandoff = {
      id: handoffId,
      receivedAtMs: Date.now(),
      pairId: message.pairId,
    };

    const steerText = [
      "[LEAD-WORKER HANDOFF]",
      `handoff_id: ${handoffId}`,
      "",
      handoffText,
    ].join("\n");

    pi.sendMessage(
      {
        customType: BUILD_HANDOFF_MESSAGE_TYPE,
        content: steerText,
        display: true,
        details: { handoffId, pairId: message.pairId },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );

    return createMessage({
      type: "reply",
      from: "worker",
      to: "lead",
      pairId: message.pairId,
      replyTo: message.id,
      ok: true,
      handoffId,
      body: `Accepted handoff ${handoffId}.`,
    });
  }

  if (name === "slash_command") {
    const payload = typeof message.payload === "object" && message.payload !== null ? (message.payload as Record<string, unknown>) : {};
    const commandText = typeof payload.command === "string" && payload.command.trim() ? payload.command.trim() : (message.body ?? "").trim();
    if (!commandText.startsWith("/")) {
      throw new Error("worker slash command must start with '/'.");
    }

    const [commandName] = commandText.slice(1).split(/\s+/, 1);
    if (!commandName) {
      throw new Error("worker slash command name is required.");
    }

    const registered = pi.getCommands().some((command) => command.name === commandName);
    if (!registered) {
      throw new Error(`Worker slash command '/${commandName}' is not registered in the current worker session.`);
    }

    await pi.sendUserMessage(commandText);

    return createMessage({
      type: "reply",
      from: "worker",
      to: "lead",
      pairId: message.pairId,
      replyTo: message.id,
      ok: true,
      body: `Submitted worker slash command ${commandText} (fire-and-forget; async failures will not be reported back).`,
      payload: { command: commandText },
    });
  }

  throw new Error(`Unknown worker command '${name}'.`);
}

async function handleLeadCommand(_pi: ExtensionAPI, _ctx: ExtensionContext, message: PairMessageV2): Promise<PairMessageV2> {
  throw new Error(`Lead command '${message.name ?? ""}' is not implemented.`);
}

function activeConnectionMatches(message: PairMessageV2, sourceSocket?: Socket): boolean {
  if (currentPairRole() === "lead") {
    return !!rt.activeConnection && rt.activeConnection.pairId === message.pairId;
  }
  return !!rt.activeLeadSocket && rt.activeLeadSocket === sourceSocket && rt.workerServerPairId === message.pairId;
}

async function handleIncomingMessage(pi: ExtensionAPI, message: PairMessageV2, sourceSocket?: Socket): Promise<void> {
  const ctx = rt.latestPairContext;
  if (!ctx) throw new Error("No active extension context available for lead-worker message handling.");
  if (message.to !== currentPairRole()) throw new Error(`Unexpected destination '${message.to}' for role '${currentPairRole()}'.`);

  if (currentPairRole() === "worker" && message.type === "command" && message.name === "attach") {
    const socket = sourceSocket;
    if (!socket) throw new Error("attach requires a source socket.");
    const reply = await handleWorkerCommand(pi, ctx, message, socket);
    sendProtocolMessage(socket, reply);
    await flushQueuedWorkerEvents((await resolveRuntimeContext(pi, ctx)).protocolDir, socket, message.pairId);
    return;
  }

  if (!activeConnectionMatches(message, sourceSocket)) throw new Error(`Wrong pairId ${message.pairId} for active connection.`);

  if (message.type === "reply") {
    const pending = rt.pendingRpc.get(message.replyTo ?? "");
    if (pending) {
      clearPendingRpc(message.replyTo ?? "");
      pending.resolve(message);
      return;
    }
    if (message.replyTo && rt.expiredRpcIds.has(message.replyTo)) {
      notify(ctx, `lead-worker stale reply ignored: ${message.replyTo}`, "warning");
      return;
    }
    throw new Error(`Unexpected reply for unknown request id '${message.replyTo ?? "(none)"}'.`);
  }

  if (message.type === "event") {
    if (currentPairRole() === "lead") {
      const eventName = message.name ?? "event";
      if (eventName === "busy") {
        rt.connectionError = message.body ?? "Worker is already attached to another active lead connection.";
        notify(ctx, rt.connectionError, "error");
      } else if (eventName === "progress" || eventName === "readiness") {
        notify(ctx, message.body ?? `Worker event: ${eventName}`, "info");
        if (eventName === "progress") {
          void maybeRunLeadSupervision(pi, ctx, message, sendOneWayEvent).catch((err) => {
            notify(ctx, `lead supervisor error: ${err instanceof Error ? err.message : String(err)}`, "warning");
          });
        }
      } else {
        deliverIncomingProtocolMessage(pi, message, true);
        maybeRelayWorkerEventToUser(pi, message);
        void maybeRunLeadSupervision(pi, ctx, message, sendOneWayEvent).catch((err) => {
          notify(ctx, `lead supervisor error: ${err instanceof Error ? err.message : String(err)}`, "warning");
        });
      }
    } else {
      deliverIncomingProtocolMessage(pi, message, true);
    }
    return;
  }

  if (message.type === "request") {
    registerInboundRequest(message);
    deliverIncomingProtocolMessage(pi, message, true);
    promptForReply(pi, message);
    return;
  }

  if (message.type === "command") {
    const socket = activeSocketForRole(currentPairRole());
    if (!socket) throw new Error("No active socket available for command reply.");
    try {
      const reply = currentPairRole() === "worker"
        ? await handleWorkerCommand(pi, ctx, message, sourceSocket)
        : await handleLeadCommand(pi, ctx, message);
      sendProtocolMessage(socket, reply);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      sendProtocolMessage(socket, createMessage({
        type: "reply",
        from: currentPairRole(),
        to: pairedRole(currentPairRole()),
        pairId: message.pairId,
        replyTo: message.id,
        ok: false,
        error: err.message,
        handoffId: message.handoffId,
        body: err.message,
      }));
    }
    return;
  }
}

async function sendOneWayEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: { name: string; body: string; handoffId?: string; autoStart: boolean; failIfUnavailable: boolean },
): Promise<{ ok: true; action: "message"; pairId: string; to: PairRole; name: string; handoffId?: string; queued?: boolean }> {
  const role = currentPairRole();
  const runtime = await resolveRuntimeContext(pi, ctx);
  const socket = role === "lead"
    ? (await ensureLeadConnection(pi, ctx, { autoStart: params.autoStart, failIfUnavailable: params.failIfUnavailable })).socket
    : activeSocketForRole("worker");

  const message = createMessage({
    type: "event",
    from: role,
    to: pairedRole(role),
    pairId: runtime.pairId,
    name: params.name,
    body: params.body,
    handoffId: params.handoffId,
  });

  if (role === "worker" && (!socket || socket.destroyed)) {
    await enqueueWorkerEvent(runtime.protocolDir, message);
    return { ok: true, action: "message", pairId: runtime.pairId, to: message.to, name: params.name, handoffId: params.handoffId, queued: true };
  }
  if (!socket) {
    throw new Error("Worker is not currently attached to an active lead connection.");
  }

  const queued = role === "worker"
    ? await deliverWorkerEvent(runtime.protocolDir, socket, message)
    : (sendProtocolMessage(socket, message), false);
  return { ok: true, action: "message", pairId: runtime.pairId, to: message.to, name: params.name, handoffId: params.handoffId, ...(queued ? { queued: true } : {}) };
}

async function sendAskAction(pi: ExtensionAPI, ctx: ExtensionContext, name: string | undefined, text: string): Promise<unknown> {
  const role = currentPairRole();
  const runtime = await resolveRuntimeContext(pi, ctx);
  const socket = role === "lead"
    ? (await ensureLeadConnection(pi, ctx, { autoStart: true, failIfUnavailable: true })).socket
    : activeSocketForRole("worker");
  if (!socket) {
    throw new Error(role === "worker"
      ? "Lead is not currently attached to the worker, so worker ask cannot be delivered."
      : "Worker is not currently attached to an active lead connection.");
  }

  const message = createMessage({
    type: "request",
    from: role,
    to: pairedRole(role),
    pairId: runtime.pairId,
    name,
    body: text,
  });
  const reply = await startRpc(message, socket);
  if (!reply.ok) throw new Error(reply.error ?? reply.body ?? `Request '${name ?? message.id}' failed.`);
  return { ok: true, action: "ask", pairId: runtime.pairId, name, reply };
}

async function sendCommandAction(pi: ExtensionAPI, ctx: ExtensionContext, name: string, text: string): Promise<unknown> {
  if (currentPairRole() !== "lead") {
    throw new Error("lead_worker({ action: \"command\", ... }) is only implemented from the lead to the worker.");
  }

  const connection = await ensureLeadConnection(pi, ctx, { autoStart: true, failIfUnavailable: true });
  const payload = name === "model"
    ? { ref: text.trim() }
    : name === "thinking"
      ? { level: text.trim() }
      : name === "slash_command"
        ? { command: text.trim() }
        : undefined;
  const message = createMessage({
    type: "command",
    from: "lead",
    to: "worker",
    pairId: connection.pairId,
    name,
    body: text,
    payload,
  });
  const reply = await startRpc(message, connection.socket);
  if (!reply.ok) throw new Error(reply.error ?? reply.body ?? `Command '${name}' failed.`);
  return { ok: true, action: "command", pairId: connection.pairId, name, reply };
}

async function sendReplyAction(pi: ExtensionAPI, ctx: ExtensionContext, replyTo: string, text: string): Promise<unknown> {
  const pending = rt.pendingInboundRequests.get(replyTo);
  if (!pending) throw new Error(`No pending inbound request '${replyTo}'.`);

  const role = currentPairRole();
  const runtime = await resolveRuntimeContext(pi, ctx);
  const socket = role === "lead"
    ? (await ensureLeadConnection(pi, ctx, { autoStart: true, failIfUnavailable: true })).socket
    : activeSocketForRole("worker");
  if (!socket) throw new Error("Worker is not currently attached to an active lead connection.");

  const reply = createMessage({
    type: "reply",
    from: role,
    to: pending.from,
    pairId: runtime.pairId,
    replyTo,
    ok: true,
    body: text.trim(),
  });
  sendProtocolMessage(socket, reply);
  clearInboundRequest(replyTo);
  return { ok: true, action: "reply", pairId: runtime.pairId, replyTo };
}

async function sendMessageAction(pi: ExtensionAPI, ctx: ExtensionContext, rawMessage: string | undefined, name?: string): Promise<unknown> {
  const trimmed = (rawMessage ?? "").trim();
  if (!trimmed) throw new Error("message text is required");
  const role = currentPairRole();
  const pendingHandoffId = role === "worker" ? rt.pendingWorkerHandoff?.id : undefined;
  const inferredName = name?.trim() || (role === "worker" ? inferWorkerEventName(trimmed, rt.pendingWorkerHandoff) : "message");
  const result = await sendOneWayEvent(pi, ctx, {
    name: inferredName,
    body: trimmed,
    handoffId: pendingHandoffId,
    autoStart: false,
    failIfUnavailable: true,
  });
  if (role === "worker" && isTerminalSupervisionEvent(inferredName)) {
    rt.pendingWorkerHandoff = undefined;
  }
  return result;
}

function buildHandoffText(ctx: ExtensionContext, extraInstructions: string, handoffId: string): string | null {
  const recent = getMessagesSinceLastUser(ctx);
  const trimmedExtra = extraInstructions.trim();
  if (recent.length === 0 && !trimmedExtra) return null;

  const lines = [
    `Lead handoff from session ${ctx.sessionManager.getSessionId()} in ${ctx.cwd ?? process.cwd()}.`,
    "Implement the agreed plan in the repo-scoped worker. The lead should avoid direct repo edits.",
    `handoff_id: ${handoffId}`,
    'Direct paired communication is available through lead_worker({ action: "message", name: "progress", message: "..." }) and lead_worker({ action: "reply", replyTo: "...", message: "..." }).',
    "",
  ];

  if (trimmedExtra) lines.push("Additional build instruction:", trimmedExtra, "");
  if (recent.length > 0) {
    lines.push("Recent lead exchange:", "");
    for (const message of recent) {
      const role = message.role === "user" ? "User" : "Lead";
      lines.push(`${role}:`, message.content, "");
    }
  }

  lines.push(
    "Execution expectations:",
    "- send intent/spec only: goal, relevant files, implementation steps, constraints, and validation criteria",
    "- do not send concrete code snippets, patches, or copy-paste-ready implementation blocks to the worker",
    "- implement the requested change in the worker session",
    "- run the smallest relevant validation",
    '- send exactly one terminal update to the lead for this handoff via lead_worker({ action: "message", name: "completed" | "failed" | "cancelled", message: "..." }) including handoff_id, status, files changed, and validation results',
    '- send progress/blocker/clarification updates only when materially useful',
    "- if blocked on the task itself, report the minimal blocker and the next action needed",
  );

  const joined = lines.join("\n").trim();
  return joined.length <= MAX_HANDOFF_CHARS ? joined : joined.slice(0, MAX_HANDOFF_CHARS - 1) + "…";
}

function formatBuildQueuedMarkdown(worker: WorkerStatus, pairId: string, handoffId: string): string {
  return [
    `**worker build delegated**`,
    "",
    `- lead mode: ${rt.modeEnabled ? "on" : "off"}`,
    `- pair id: ${pairId}`,
    `- worker name: ${worker.agentName}`,
    `- worker running: ${worker.running ? "yes" : "no"}`,
    `- worker session: ${worker.tmuxSession}`,
    `- handoff id: ${handoffId}`,
    `- paired transport: protocol-v2 worker socket`,
  ].join("\n");
}

async function handleBuildDelegation(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  if (!rt.modeEnabled) {
    throw new Error("lead-worker mode is off. Run /lead on before using /worker build.");
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.hasUI && ctx.ui.notify("Wait for the lead to finish its current turn before delegating with /worker build.", "warning");
    return;
  }

  const { settings } = await refreshSettings(ctx.cwd ?? process.cwd());
  const handoffId = randomUUID();
  const handoff = buildHandoffText(ctx, args, handoffId);
  if (!handoff) {
    ctx.hasUI && ctx.ui.notify("No recent lead context found. Ask the lead first or pass explicit instructions to /worker build.", "error");
    return;
  }

  await resolveLeadSupervisionModel(ctx);

  let worker = await getWorkerStatus(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
  if (!worker.running) {
    worker = await startWorker(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
    updateStatusLine(ctx, worker);
  }

  const connection = await ensureLeadConnection(pi, ctx, { autoStart: true, failIfUnavailable: true });
  const supervised: ActiveSupervisedHandoff = {
    id: handoffId,
    spec: handoff,
    outcome: truncate(handoff, 500),
    steerCount: 0,
    recentEvents: [],
    pendingEvents: [],
    supervisionRunning: false,
  };
  rt.activeSupervisedHandoff = supervised;

  try {
    const command = createMessage({
      type: "command",
      from: "lead",
      to: "worker",
      pairId: connection.pairId,
      name: "handoff",
      handoffId,
      body: handoff,
      payload: { handoffId, text: handoff },
    });
    const reply = await startRpc(command, connection.socket);
    if (!reply.ok) throw new Error(reply.error ?? reply.body ?? `Worker rejected handoff ${handoffId}.`);

    const haikuModel = getModel(SUPERVISOR_MODEL_PROVIDER, SUPERVISOR_MODEL_ID);
    if (haikuModel) {
      const registry = ctx.modelRegistry as unknown as Record<string, unknown>;
      const auth = typeof registry.getApiKeyAndHeaders === "function"
        ? await (registry.getApiKeyAndHeaders as (m: unknown) => Promise<{ ok?: boolean; apiKey?: string }>)(haikuModel).catch(() => ({ ok: false as const, apiKey: undefined }))
        : { ok: false as const, apiKey: undefined };
      if (auth.ok && auth.apiKey) {
        supervised.outcome = await synthesizeOutcome(handoff, auth.apiKey);
      }
    }
  } catch (error) {
    if (rt.activeSupervisedHandoff === supervised) {
      rt.activeSupervisedHandoff = undefined;
    }
    throw error;
  }

  emitInfo(pi, formatBuildQueuedMarkdown(worker, connection.pairId, handoffId), BUILD_HANDOFF_MESSAGE_TYPE);
}

type WorkerInterruptState = { tmuxSession: string; tmuxPaneId?: string; agentName?: string };
type WorkerInterruptResolution = { cwd: string; state: WorkerInterruptState };

function isWorkerInterruptState(value: unknown): value is WorkerInterruptState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.tmuxSession === "string" && (state.tmuxPaneId === undefined || typeof state.tmuxPaneId === "string");
}

function tmuxExecSucceeded(result: { code?: number | null }): boolean {
  return (result.code ?? 1) === 0;
}

async function resolveWorkerInterruptState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<WorkerInterruptResolution | null> {
  if (!rt.modeEnabled || currentPairRole() !== "lead") return null;

  const cwd = ctx.cwd ?? process.cwd();
  const runtime = await resolveRuntimeContext(pi, ctx);
  const statePath = join(runtime.runtimeDir, "worker-state.json");

  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw new Error(`Failed to read worker state file ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isWorkerInterruptState(parsed)) {
    throw new Error(`Invalid worker state file ${statePath}: missing tmuxSession`);
  }

  const hasSession = await pi.exec("tmux", ["has-session", "-t", parsed.tmuxSession], { cwd, timeout: 5_000 });
  if (!tmuxExecSucceeded(hasSession)) return null;
  return { cwd, state: parsed };
}

async function interruptWorkerIfRunning(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  const resolved = await resolveWorkerInterruptState(pi, ctx);
  if (!resolved) return false;

  const { cwd, state } = resolved;
  const target = state.tmuxPaneId?.trim() || `${state.tmuxSession}:0.0`;
  const sent = await pi.exec("tmux", ["send-keys", "-t", target, "C-c"], { cwd, timeout: 5_000 });
  if (!tmuxExecSucceeded(sent)) {
    throw new Error(sent.stderr?.trim() || sent.stdout?.trim() || `Failed to interrupt worker pane ${target}`);
  }

  const agentName = state.agentName?.trim() || "worker";
  ctx.hasUI && ctx.ui.notify(`Sent interrupt to ${agentName} (${target}).`, "warning");
  return true;
}

async function ensureWorkerServer(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (currentPairRole() !== "worker") return;
  const runtime = await resolveRuntimeContext(pi, ctx);
  if (rt.workerServer && rt.workerServerSocketPath === runtime.socketPath) return;

  if (rt.workerServer) {
    await new Promise<void>((resolve) => rt.workerServer?.close(() => resolve()));
    rt.workerServer = undefined;
    rt.workerServerSocketPath = undefined;
    rt.workerServerPairId = undefined;
    rt.activeLeadSocket = undefined;
    rt.activeLeadSessionId = undefined;
  }

  await fs.mkdir(join(runtime.runtimeDir, "protocol-v2"), { recursive: true });
  try {
    await fs.unlink(runtime.socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw error;
  }

  const server = createServer((socket) => {
    const reader = createMessageReader(
      (message) => {
        void handleIncomingMessage(pi, message, socket).catch((error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          console.warn("[lead-worker] worker protocol failed:", err);
          socket.destroy(err);
        });
      },
      (error) => {
        console.warn("[lead-worker] worker protocol failed:", error);
        socket.destroy(error);
      },
    );

    socket.on("data", reader);
    socket.on("close", () => {
      if (rt.activeLeadSocket === socket) {
        rt.activeLeadSocket = undefined;
        rt.activeLeadSessionId = undefined;
      }
    });
    socket.on("error", () => {
      if (rt.activeLeadSocket === socket) {
        rt.activeLeadSocket = undefined;
        rt.activeLeadSessionId = undefined;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.socketPath, () => resolve());
  });

  rt.workerServer = server;
  rt.workerServerSocketPath = runtime.socketPath;
  rt.workerServerPairId = runtime.pairId;
}

export default function leadWorkerExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Lead Worker",
    description:
      "Manage lead-worker mode and the current repo-scoped worker configured by lead-worker-settings.yaml. " +
      "Actions: start, on, status, off, stop, message, ask, command, reply. " +
      "Control actions start/on/status/off/stop are lead-only: start spawns the worker without changing mode; on enables no-direct-repo-edit lead mode, switches the lead to the configured planning model, and starts the worker if needed; off restores normal lead behavior and restores the previous model/thinking while leaving the worker alone; stop forcibly terminates the worker and, if lead-worker mode is on, also returns the lead to normal mode; message sends a one-way paired event from either side; ask sends a blocking paired request from the lead or an attached worker; command sends a blocking operational command from the lead to the worker; reply answers a pending paired request. For lead-side worker inspection and direct worker slash commands, use /worker.",
    parameters: Type.Object({
      action: StringEnum(["start", "on", "status", "off", "stop", "message", "ask", "command", "reply"] as const, {
        description: "Lead-worker control or communication action",
      }),
      name: Type.Optional(Type.String({ description: "Required for action='command'. Optional event/request name for action='message' or action='ask'." })),
      message: Type.Optional(Type.String({ description: "Required for actions 'message', 'ask', and 'reply'. Optional command argument text for action='command'." })),
      replyTo: Type.Optional(Type.String({ description: "Required for action='reply'. The pending request id to answer." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (params.action === "message") {
          const result = await sendMessageAction(pi, ctx, params.message, params.name);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        }
        if (params.action === "ask") {
          const result = await sendAskAction(pi, ctx, params.name, params.message ?? "");
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        }
        if (params.action === "command") {
          if (!params.name?.trim()) throw new Error("name is required for action='command'.");
          const result = await sendCommandAction(pi, ctx, params.name, params.message ?? "");
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        }
        if (params.action === "reply") {
          if (!params.replyTo?.trim()) throw new Error("replyTo is required for action='reply'.");
          const result = await sendReplyAction(pi, ctx, params.replyTo, params.message ?? "");
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        }

        const status = await runControlAction(pi, ctx, params.action, maybePrimeLeadConnection);
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: status };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }, null, 2) }],
          details: { ok: false, error: message },
        };
      }
    },
  });

  async function handleControlCommand(args: string, ctx: ExtensionContext, usage: string) {
    if (currentPairRole() !== "lead") {
      ctx.hasUI && ctx.ui.notify("/lead is only available from the lead session.", "error");
      return;
    }

    let action: LeadWorkerControlAction | null = null;
    try {
      action = await resolveCommandAction(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`lead-worker failed: ${message}`, "error");
      return;
    }

    if (!action) {
      ctx.hasUI && ctx.ui.notify(usage, "error");
      return;
    }

    try {
      const status = await runControlAction(pi, ctx, action, maybePrimeLeadConnection);
      emitInfo(pi, formatStatusMarkdown(status), BUILD_HANDOFF_MESSAGE_TYPE);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`lead-worker failed: ${message}`, "error");
    }
  }

  async function handleWorkerSlashCommand(args: string, ctx: ExtensionContext) {
    const usage = "Usage: /worker status | /worker build [instructions] | /worker /<command> [args]";
    if (currentPairRole() !== "lead") {
      ctx.hasUI && ctx.ui.notify("/worker is only available from the lead session.", "error");
      return;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      ctx.hasUI && ctx.ui.notify(usage, "error");
      return;
    }

    try {
      if (trimmed === "status") {
        emitInfo(pi, await queryWorkerStatusPassive(pi, ctx, ensureLeadConnection, startRpc), BUILD_HANDOFF_MESSAGE_TYPE);
        return;
      }

      if (trimmed === "build" || trimmed.startsWith("build ")) {
        const buildArgs = trimmed === "build" ? "" : trimmed.slice("build".length).trimStart();
        await handleBuildDelegation(pi, ctx, buildArgs);
        return;
      }

      if (!trimmed.startsWith("/")) {
        ctx.hasUI && ctx.ui.notify(usage, "error");
        return;
      }

      const result = await sendCommandAction(pi, ctx, "slash_command", trimmed);
      const reply = (result as { reply?: PairMessageV2 }).reply;
      emitInfo(
        pi,
        [
          "**worker command**",
          "",
          `- command: ${trimmed}`,
          ...(reply?.body ? [`- result: ${reply.body}`] : []),
        ].join("\n"),
        BUILD_HANDOFF_MESSAGE_TYPE,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`worker command failed: ${message}`, "error");
    }
  }

  pi.registerCommand("lead", {
    description: "Control lead-worker mode and the current worker: /lead [start|on|status|off|stop] (bare command toggles mode; on switches the lead model, off restores it, stop also exits lead-worker mode if it is on)",
    handler: async (args, ctx) => handleControlCommand(args, ctx, "Usage: /lead [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("worker", {
    description: "Inspect the paired worker, delegate execution, or run a registered slash command inside it: /worker status | /worker build [instructions] | /worker /<command> [args]",
    handler: async (args, ctx) => {
      await handleWorkerSlashCommand(args, ctx);
    },
  });

  pi.registerCommand("abort", {
    description: "Abort the current lead turn, or when lead-worker mode is on and the worker is running, send Ctrl+C to the paired worker's active tmux pane.",
    handler: async (_args, ctx) => {
      try {
        if (await interruptWorkerIfRunning(pi, ctx)) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI && ctx.ui.notify(`worker interrupt failed during /abort: ${message}; aborting lead turn instead.`, "error");
      }
      await ctx.abort();
    },
  });

  pi.on("tool_call", async (event) => {
    if (!rt.modeEnabled) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      return { block: true, reason: `lead-worker mode is on: the lead should avoid direct repo edits. Use /worker build to delegate execution to ${workerSessionReference()}.` };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isSafeLeadBash(command)) {
        return { block: true, reason: `lead-worker mode is on: obvious repo-mutating bash is blocked for the lead. Use /worker build to delegate execution to ${workerSessionReference()}.\nCommand: ${command}` };
      }
    }

    if (event.toolName === TOOL_NAME) {
      const action = typeof event.input.action === "string" ? event.input.action : "";
      if (!["message", "ask", "command", "reply"].includes(action)) {
        return {
          block: true,
          reason: `lead-worker mode is on: worker lifecycle control should go through explicit slash commands (/lead, /worker). Allowed tool calls are lead_worker communication actions: message, ask, command, and reply.`,
        };
      }
    }
  });

  pi.on("context", async (event) => {
    if (rt.modeEnabled) return;
    return {
      messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== CONTEXT_MESSAGE_TYPE),
    };
  });

  pi.on("before_agent_start", async () => {
    if (!rt.modeEnabled) return;

    const lines = [
      "[LEAD-WORKER MODE ACTIVE]",
      "You are the lead half of a lead→worker workflow.",
      "",
      "Lead rules:",
      "- Do not directly edit repository files from the lead.",
      "- Bash is available for broad inspection/prep work, but avoid obvious repo-mutating commands.",
      "- Focus on understanding the codebase, producing plans, reviewing results, and preparing precise worker instructions.",
      "- Send intent/spec to the worker, not implementation code. Do not send concrete code snippets, patches, or copy-paste-ready blocks.",
      "- When the user wants execution, they will run /worker build to delegate the current plan to the repo-scoped worker.",
      '- You may communicate with the paired worker using lead_worker({ action: "message" | "ask" | "command" | "reply", ... }).',
      "- The paired worker may also message you or ask direct clarification questions. Answer only when it materially helps execution.",
      "- Prefer concise worker handoff packets with: goal, relevant files, implementation steps, and validation.",
    ];

    const leadPromptAppend = leadConfig().prompt_append;
    if (leadPromptAppend) lines.push("", leadPromptAppend);

    return {
      message: {
        customType: CONTEXT_MESSAGE_TYPE,
        content: lines.join("\n"),
        display: false,
      },
    };
  });

  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    rt.latestPairContext = ctx;
    rt.lastObservedLeadModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
    await restoreModeState(pi, ctx).catch((err) => {
      console.warn("[lead-worker] restoreModeState failed:", err);
      notify(ctx, `lead-worker restore failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    });
    if (currentPairRole() === "worker") {
      await ensureWorkerServer(pi, ctx).catch((err) => {
        console.warn("[lead-worker] ensureWorkerServer failed:", err);
        notify(ctx, `lead-worker worker server failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      });
    } else {
      await maybePrimeLeadConnection(pi, ctx);
    }
  };

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", async (event) => {
    rt.lastObservedLeadModel = { provider: event.model.provider, modelId: event.model.id };
  });

  pi.on("turn_end", async (_event, ctx) => {
    rt.latestPairContext = ctx;
    maybeAutoReportWorkerCompletion();
  });
}
