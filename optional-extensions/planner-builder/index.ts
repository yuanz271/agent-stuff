import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getModel, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
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
  getBuilderStatus,
  resolvePairRuntimePaths,
  startBuilder,
  type BuilderStatus,
} from "./utils.js";
import {
  BUILD_HANDOFF_MESSAGE_TYPE,
  CONTEXT_MESSAGE_TYPE,
  MAX_TRACKED_REPORTED_HANDOFF_IDS,
  SOCKET_WAIT_INTERVAL_MS,
  SOCKET_WAIT_TIMEOUT_MS,
  SUPERVISOR_MODEL_ID,
  SUPERVISOR_MODEL_PROVIDER,
  TOOL_NAME,
  rt,
  currentPairRole,
  getContextCwd,
  getPlannerSessionBinding,
  isTerminalSupervisionEvent,
  plannerConfig,
  pairedRole,
  refreshSettings,
  truncate,
  type ActiveConnection,
  type ActiveSupervisedHandoff,
  type PlannerBuilderControlAction,
  type PendingInboundRequest,
  type PendingRpc,
} from "./runtime.js";
import {
  emitInfo,
  formatStatusMarkdown,
  resolveCommandAction,
  restoreModeState,
  runControlAction,
  updateStatusLine,
} from "./control.js";
import {
  deliverIncomingProtocolMessage,
  formatBuilderStatusReply,
  inferBuilderEventName,
  maybeAutoReportBuilderCompletion,
  maybeRelayBuilderEventToUser,
  promptForReply,
  queryBuilderStatusPassive,
} from "./relay.js";
import {
  maybeRunPlannerSupervision,
  resolvePlannerSupervisionModel,
  synthesizeOutcome,
} from "./supervision.js";
import {
  buildExecutionUpdatePayload,
  isHighSignalBuilderEvent,
  parseExecutionUpdatePayload,
  type ExecutionUpdatePayload,
  type HighSignalUpdateStatus,
} from "./execution-updates.js";
import {
  buildHandoffPointerText,
  buildHandoffText,
  validateHandoffArtifact,
  writeHandoffArtifact,
} from "./handoff.js";
import {
  clarificationStateFromExecutionUpdate,
  clearPendingClarification,
  pendingClarificationFromMessage,
  pendingClarificationSnapshot,
  rememberPendingClarification,
  restorePendingClarificationState,
} from "./clarification.js";

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

function isSafePlannerBash(command: string): boolean {
  const commandForMutatingChecks = stripBenignRedirects(command);
  return !CORE_BLOCKED_BASH_PATTERNS.some((pattern) => pattern.test(commandForMutatingChecks));
}

function builderSessionReference(): string {
  return "the paired builder session";
}

function notify(ctx: ExtensionContext | undefined, message: string, severity: "info" | "warning" | "error" = "info"): void {
  if (ctx?.hasUI) ctx.ui.notify(message, severity);
}

function requireLatestPairContext(): ExtensionContext {
  const ctx = rt.latestPairContext;
  if (!ctx) throw new Error("No active extension context available for planner-builder message handling.");
  return ctx;
}

function schedulePlannerSupervision(pi: ExtensionAPI, ctx: ExtensionContext, message: PairMessageV2): void {
  void maybeRunPlannerSupervision(pi, ctx, message, sendOneWayEvent).catch((err) => {
    notify(ctx, `planner-builder supervision error: ${err instanceof Error ? err.message : String(err)}`, "warning");
  });
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
  return role === "planner" ? rt.activeConnection?.socket : rt.activePlannerSocket;
}

function markPendingBuilderHandoffTerminalEvent(message: PairMessageV2): void {
  const pending = rt.pendingBuilderHandoff;
  if (!pending) return;
  if (message.from !== "builder" || message.type !== "event") return;
  if (!isTerminalSupervisionEvent(message.name ?? "")) return;
  if (message.handoffId !== pending.id) return;
  pending.terminalEventSentAtMs = Date.now();
}

function sendProtocolMessage(socket: Socket, message: PairMessageV2): void {
  writeMessage(socket, message);
  markPendingBuilderHandoffTerminalEvent(message);
}

function currentBuilderExecutionUpdateDefaults() {
  return {
    handoffId: rt.pendingBuilderHandoff?.id,
    handoffArtifactPath: rt.pendingBuilderHandoff?.artifactPath,
    handoffArtifactSha256: rt.pendingBuilderHandoff?.artifactSha256,
  };
}

function normalizeBuilderExecutionUpdatePayload(
  status: HighSignalUpdateStatus,
  rawPayload: unknown,
): ExecutionUpdatePayload {
  if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
    throw new Error(`builder ${status} event requires a structured payload object`);
  }

  const candidate: Record<string, unknown> = { ...(rawPayload as Record<string, unknown>) };
  const defaults = currentBuilderExecutionUpdateDefaults();
  if (candidate.handoffId === undefined && defaults.handoffId) {
    candidate.handoffId = defaults.handoffId;
  }
  if (candidate.handoffArtifactPath === undefined && defaults.handoffArtifactPath) {
    candidate.handoffArtifactPath = defaults.handoffArtifactPath;
  }
  if (candidate.handoffArtifactSha256 === undefined && defaults.handoffArtifactSha256) {
    candidate.handoffArtifactSha256 = defaults.handoffArtifactSha256;
  }
  return parseExecutionUpdatePayload(candidate, status);
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
  const cwd = getContextCwd(ctx);
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

function isRetryableBuilderSocketError(error: Error): boolean {
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

async function connectToBuilderSocket(socketPath: string, timeoutMs = SOCKET_WAIT_TIMEOUT_MS): Promise<Socket> {
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
      if (!isRetryableBuilderSocketError(err) || Date.now() + SOCKET_WAIT_INTERVAL_MS >= deadline) {
        break;
      }
      await delay(SOCKET_WAIT_INTERVAL_MS);
    }
  }

  throw new Error(
    `Failed to connect to builder socket ${socketPath} within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : "."}`,
  );
}

function queuedBuilderEventsPath(protocolDir: string): string {
  return join(protocolDir, "pending-events.json");
}

function validateQueuedBuilderEvent(value: unknown): PairMessageV2 {
  const message = validateMessage(value);
  if (message.type !== "event") throw new Error(`Queued message ${message.id} must be an event.`);
  if (message.from !== "builder" || message.to !== "planner") {
    throw new Error(`Queued message ${message.id} must be builder→planner.`);
  }
  return message;
}

async function loadQueuedBuilderEvents(protocolDir: string): Promise<PairMessageV2[]> {
  const queuePath = queuedBuilderEventsPath(protocolDir);
  let raw: string;
  try {
    raw = await fs.readFile(queuePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return [];
    throw new Error(`Failed to read queued builder events ${queuePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Queued builder events file ${queuePath} must contain a JSON array.`);
  }
  return parsed.map(validateQueuedBuilderEvent);
}

async function saveQueuedBuilderEvents(protocolDir: string, events: PairMessageV2[]): Promise<void> {
  const queuePath = queuedBuilderEventsPath(protocolDir);
  if (events.length === 0) {
    try {
      await fs.unlink(queuePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw new Error(`Failed to clear queued builder events ${queuePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return;
  }

  await fs.mkdir(protocolDir, { recursive: true });
  await fs.writeFile(queuePath, JSON.stringify(events, null, 2) + "\n", "utf8");
}

const builderEventQueueLocks = new Map<string, Promise<void>>();

function withQueueLock<T>(protocolDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = builderEventQueueLocks.get(protocolDir) ?? Promise.resolve();
  const next = prev.then(fn);
  const settled = next.then(
    () => { if (builderEventQueueLocks.get(protocolDir) === settled) builderEventQueueLocks.delete(protocolDir); },
    () => { if (builderEventQueueLocks.get(protocolDir) === settled) builderEventQueueLocks.delete(protocolDir); },
  );
  builderEventQueueLocks.set(protocolDir, settled);
  return next;
}

async function enqueueBuilderEvent(protocolDir: string, message: PairMessageV2): Promise<void> {
  await withQueueLock(protocolDir, async () => {
    const queued = await loadQueuedBuilderEvents(protocolDir);
    queued.push(message);
    await saveQueuedBuilderEvents(protocolDir, queued);
  });
  markPendingBuilderHandoffTerminalEvent(message);
}

async function flushQueuedBuilderEvents(protocolDir: string, socket: Socket, pairId: string): Promise<void> {
  await withQueueLock(protocolDir, async () => {
    const queued = await loadQueuedBuilderEvents(protocolDir);
    if (queued.length === 0) return;

    let sent = 0;
    try {
      for (const message of queued) {
        if (message.pairId !== pairId) {
          throw new Error(`Queued builder event ${message.id} has wrong pairId ${message.pairId}.`);
        }
        sendProtocolMessage(socket, message);
        sent++;
      }
    } catch (error) {
      await saveQueuedBuilderEvents(protocolDir, queued.slice(sent));
      throw error;
    }

    await saveQueuedBuilderEvents(protocolDir, []);
  });
}

async function deliverBuilderEvent(protocolDir: string, socket: Socket | undefined, message: PairMessageV2): Promise<boolean> {
  if (!socket || socket.destroyed) {
    await enqueueBuilderEvent(protocolDir, message);
    return true;
  }

  sendProtocolMessage(socket, message);
  return false;
}

function createAttachMessage(pairId: string, plannerSessionId: string): PairMessageV2 {
  return createMessage({
    type: "command",
    from: "planner",
    to: "builder",
    pairId,
    name: "attach",
    payload: { plannerSessionId },
    body: `Attach planner session ${plannerSessionId}`,
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

async function ensurePlannerConnection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { autoStart: boolean },
): Promise<ActiveConnection> {
  if (currentPairRole() !== "planner") {
    throw new Error("Only the planner session can initiate a builder socket connection.");
  }

  const cwd = getContextCwd(ctx);
  const { settings } = await refreshSettings(cwd);
  const plannerSession = getPlannerSessionBinding(ctx);
  let builder = await getBuilderStatus(pi, cwd, settings, plannerSession);
  if (!builder.running) {
    if (opts.autoStart) {
      builder = await startBuilder(pi, cwd, settings, plannerSession);
      updateStatusLine(ctx, builder);
    } else {
      throw new Error(`Builder ${builder.agentName} is not running.`);
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
    const socket = await connectToBuilderSocket(runtime.socketPath);
    const connection: ActiveConnection = {
      socket,
      pairId: runtime.pairId,
      socketPath: runtime.socketPath,
      projectRoot: runtime.projectRoot,
      plannerSessionId: plannerSession.sessionId,
    };

    const reader = createMessageReader(
      (message) => {
        void handleIncomingMessage(pi, message).catch((error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          ctx.hasUI && ctx.ui.notify(`planner-builder protocol failed: ${err.message}`, "error");
          socket.destroy(err);
        });
      },
      (error) => {
        ctx.hasUI && ctx.ui.notify(`planner-builder protocol failed: ${error.message}`, "error");
        socket.destroy(error);
      },
    );

    socket.on("data", reader);
    socket.on("error", (error) => {
      rt.connectionError = error.message;
    });
    socket.on("close", () => {
      const reason = rt.connectionError ?? "Builder connection closed.";
      onConnectionClosed(reason);
    });

    rt.activeConnection = connection;
    rt.connectionError = undefined;

    try {
      const attachReply = await startRpc(createAttachMessage(runtime.pairId, plannerSession.sessionId), socket);
      if (!attachReply.ok) {
        throw new Error(attachReply.error ?? attachReply.body ?? "Failed to attach planner connection.");
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


async function maybePrimePlannerConnection(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (currentPairRole() !== "planner") return;
  await ensurePlannerConnection(pi, ctx, { autoStart: false }).catch(() => undefined);
}

function registerInboundRequest(message: PairMessageV2): void {
  rt.pendingInboundRequests.set(message.id, {
    from: message.from,
    name: message.name,
    body: message.body,
    handoffId: message.handoffId,
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

type BuilderCommandHandler = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
  sourceSocket?: Socket,
) => Promise<PairMessageV2>;

function builderCommandPayload(message: PairMessageV2): Record<string, unknown> {
  return typeof message.payload === "object" && message.payload !== null
    ? (message.payload as Record<string, unknown>)
    : {};
}

function payloadTextValue(payload: Record<string, unknown>, key: string, body: string | undefined): string {
  return key in payload ? String(payload[key]) : (body ?? "").trim();
}

function optionalPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function artifactMetaFields(artifactMeta: { artifactPath: string; artifactSha256: string } | undefined) {
  return artifactMeta
    ? { artifactPath: artifactMeta.artifactPath, artifactSha256: artifactMeta.artifactSha256 }
    : undefined;
}

function createBuilderReply(
  message: PairMessageV2,
  body: string,
  extras: { payload?: unknown; handoffId?: string } = {},
): PairMessageV2 {
  return createMessage({
    type: "reply",
    from: "builder",
    to: "planner",
    pairId: message.pairId,
    replyTo: message.id,
    ok: true,
    body,
    ...(extras.handoffId ? { handoffId: extras.handoffId } : {}),
    ...(extras.payload !== undefined ? { payload: extras.payload } : {}),
  });
}

async function runBuilderAttachCommand(
  _pi: ExtensionAPI,
  _ctx: ExtensionContext,
  message: PairMessageV2,
  sourceSocket?: Socket,
): Promise<PairMessageV2> {
  if (!sourceSocket) throw new Error("attach requires a source socket.");
  const payload = builderCommandPayload(message);
  const plannerSessionId = typeof payload.plannerSessionId === "string" && payload.plannerSessionId.trim() ? payload.plannerSessionId.trim() : "";
  if (!plannerSessionId) throw new Error("attach requires plannerSessionId.");

  const currentSocket = rt.activePlannerSocket;
  const currentPlannerSessionId = rt.activePlannerSessionId;
  if (currentSocket && currentSocket !== sourceSocket && !currentSocket.destroyed) {
    if (currentPlannerSessionId !== plannerSessionId) {
      throw new Error("builder is already attached to another active planner connection");
    }
    rt.activePlannerSocket = sourceSocket;
    rt.activePlannerSessionId = plannerSessionId;
    currentSocket.destroy(new Error("Superseded by reconnect from same planner session."));
  } else {
    rt.activePlannerSocket = sourceSocket;
    rt.activePlannerSessionId = plannerSessionId;
  }

  return createBuilderReply(message, `Attached planner session ${plannerSessionId}.`, {
    payload: { plannerSessionId },
  });
}

async function runBuilderStatusCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
): Promise<PairMessageV2> {
  return createBuilderReply(message, formatBuilderStatusReply(pi, ctx), {
    payload: { pendingHandoffId: rt.pendingBuilderHandoff?.id },
  });
}

async function runBuilderInterruptCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
): Promise<PairMessageV2> {
  await clearPendingClarification(pi, ctx);
  await ctx.abort();
  return createBuilderReply(message, "Builder interrupt requested.");
}

async function runBuilderThinkingCommand(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  message: PairMessageV2,
): Promise<PairMessageV2> {
  const payload = builderCommandPayload(message);
  const level = payloadTextValue(payload, "level", message.body);
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
    throw new Error(`Invalid thinking level '${level}'.`);
  }
  pi.setThinkingLevel(level as ThinkingLevel);
  return createBuilderReply(message, `Builder thinking level set to ${level}.`);
}

async function runBuilderModelCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
): Promise<PairMessageV2> {
  const payload = builderCommandPayload(message);
  const ref = payloadTextValue(payload, "ref", message.body);
  const model = await resolveModelSelection(ctx, ref);
  const ok = await pi.setModel(model);
  if (!ok) throw new Error(`No API key available for ${model.provider}/${model.id}.`);
  return createBuilderReply(message, `Builder model set to ${model.provider}/${model.id}.`);
}

async function runBuilderHandoffCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
): Promise<PairMessageV2> {
  const payload = builderCommandPayload(message);
  const handoffId = optionalPayloadString(payload, "handoffId") ?? message.handoffId;
  if (!handoffId) throw new Error("handoffId is required for builder handoff command.");

  const runtime = await resolveRuntimeContext(pi, ctx);
  const summary = optionalPayloadString(payload, "summary");
  const artifactPath = optionalPayloadString(payload, "artifactPath") ?? "";
  const handoffText = optionalPayloadString(payload, "text") ?? (message.body ?? "").trim();

  let artifactMeta: { artifactPath: string; artifactSha256: string } | undefined;
  let steerText: string;
  if (artifactPath) {
    artifactMeta = await validateHandoffArtifact(runtime.runtimeDir, handoffId, payload);
    steerText = buildHandoffPointerText({
      handoffId,
      artifactPath: artifactMeta.artifactPath,
      artifactSha256: artifactMeta.artifactSha256,
      summary,
    });
  } else {
    if (!handoffText) throw new Error("handoff artifact metadata or inline handoff text is required for builder handoff command.");
    steerText = [
      "[LEAD-WORKER HANDOFF]",
      `handoff_id: ${handoffId}`,
      "",
      handoffText,
    ].join("\n");
  }

  const artifactFields = artifactMetaFields(artifactMeta);

  await clearPendingClarification(pi, ctx);
  rt.pendingBuilderHandoff = {
    id: handoffId,
    receivedAtMs: Date.now(),
    pairId: message.pairId,
    ...(artifactFields ?? {}),
  };

  pi.sendMessage(
    {
      customType: BUILD_HANDOFF_MESSAGE_TYPE,
      content: steerText,
      display: true,
      details: {
        handoffId,
        pairId: message.pairId,
        ...(artifactFields ?? {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );

  return createBuilderReply(
    message,
    artifactMeta ? `Accepted handoff ${handoffId} via artifact ${artifactMeta.artifactPath}.` : `Accepted handoff ${handoffId}.`,
    {
      handoffId,
      ...(artifactFields ? { payload: artifactFields } : {}),
    },
  );
}

async function runBuilderSlashCommand(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  message: PairMessageV2,
): Promise<PairMessageV2> {
  const payload = builderCommandPayload(message);
  const commandText = optionalPayloadString(payload, "command") ?? (message.body ?? "").trim();
  if (!commandText.startsWith("/")) {
    throw new Error("builder slash command must start with '/'.");
  }

  const [commandName] = commandText.slice(1).split(/\s+/, 1);
  if (!commandName) {
    throw new Error("builder slash command name is required.");
  }

  const registered = pi.getCommands().some((command) => command.name === commandName);
  if (!registered) {
    throw new Error(`Builder slash command '/${commandName}' is not registered in the current builder session.`);
  }

  await pi.sendUserMessage(commandText);
  return createBuilderReply(
    message,
    `Submitted builder slash command ${commandText} (fire-and-forget; async failures will not be reported back).`,
    { payload: { command: commandText } },
  );
}

const BUILDER_COMMAND_HANDLERS: Record<string, BuilderCommandHandler> = {
  attach: runBuilderAttachCommand,
  status: runBuilderStatusCommand,
  interrupt: runBuilderInterruptCommand,
  thinking: runBuilderThinkingCommand,
  model: runBuilderModelCommand,
  handoff: runBuilderHandoffCommand,
  slash_command: runBuilderSlashCommand,
};

async function handleBuilderCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
  sourceSocket?: Socket,
): Promise<PairMessageV2> {
  const name = message.name ?? "";
  const handler = BUILDER_COMMAND_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown builder command '${name}'.`);
  }
  return handler(pi, ctx, message, sourceSocket);
}

async function handlePlannerCommand(_pi: ExtensionAPI, _ctx: ExtensionContext, message: PairMessageV2): Promise<PairMessageV2> {
  throw new Error(`Planner command '${message.name ?? ""}' is not implemented.`);
}

function activeConnectionMatches(role: PairRole, message: PairMessageV2, sourceSocket?: Socket): boolean {
  if (role === "planner") {
    return !!rt.activeConnection && rt.activeConnection.pairId === message.pairId;
  }
  return !!rt.activePlannerSocket && rt.activePlannerSocket === sourceSocket && rt.builderServerPairId === message.pairId;
}

async function handleBuilderAttachCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
  sourceSocket?: Socket,
): Promise<void> {
  const socket = sourceSocket;
  if (!socket) throw new Error("attach requires a source socket.");
  const reply = await handleBuilderCommand(pi, ctx, message, socket);
  sendProtocolMessage(socket, reply);
  await flushQueuedBuilderEvents((await resolveRuntimeContext(pi, ctx)).protocolDir, socket, message.pairId);
}

function handleIncomingReply(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  role: PairRole,
  message: PairMessageV2,
): void {
  const replyTo = message.replyTo ?? "";
  const pending = rt.pendingRpc.get(replyTo);
  if (pending) {
    clearPendingRpc(replyTo);
    if (role === "builder" && rt.pendingClarification?.replyTo === replyTo) {
      void clearPendingClarification(pi, ctx).catch((err) => {
        notify(ctx, `planner-builder clarification state clear failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      });
    }
    pending.resolve(message);
    return;
  }
  if (message.replyTo && rt.expiredRpcIds.has(message.replyTo)) {
    notify(ctx, `planner-builder stale reply ignored: ${message.replyTo}`, "warning");
    return;
  }
  throw new Error(`Unexpected reply for unknown request id '${message.replyTo ?? "(none)"}'.`);
}

function parseStructuredPlannerEvent(
  ctx: ExtensionContext,
  message: PairMessageV2,
): ExecutionUpdatePayload | undefined {
  const eventName = message.name ?? "event";
  if (message.from !== "builder" || !isHighSignalBuilderEvent(eventName)) return undefined;
  try {
    return parseExecutionUpdatePayload(message.payload, eventName);
  } catch (error) {
    notify(ctx, `planner-builder invalid structured ${eventName} payload: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return undefined;
  }
}

async function handlePlannerEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: PairMessageV2,
): Promise<void> {
  const eventName = message.name ?? "event";
  const structuredUpdate = parseStructuredPlannerEvent(ctx, message);

  if (eventName === "busy") {
    rt.connectionError = message.body ?? "Builder is already attached to another active planner connection.";
    notify(ctx, rt.connectionError, "error");
    return;
  }

  if (eventName === "clarification_needed") {
    if (structuredUpdate?.status === "clarification_needed") {
      await rememberPendingClarification(pi, ctx, {
        ...pendingClarificationSnapshot(structuredUpdate.question ?? structuredUpdate.summary, message.timestamp, "durable", structuredUpdate.handoffId),
        canReplyNow: false,
      });
    }
  } else if (isTerminalSupervisionEvent(eventName)) {
    await clearPendingClarification(pi, ctx);
  }

  if (eventName === "progress" || eventName === "readiness") {
    notify(ctx, message.body ?? `Builder event: ${eventName}`, "info");
    if (eventName === "progress") {
      schedulePlannerSupervision(pi, ctx, message);
    }
    return;
  }

  deliverIncomingProtocolMessage(pi, message, true);
  maybeRelayBuilderEventToUser(pi, message);
  schedulePlannerSupervision(pi, ctx, message);
}

async function handleIncomingEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  role: PairRole,
  message: PairMessageV2,
): Promise<void> {
  if (role === "planner") {
    await handlePlannerEvent(pi, ctx, message);
    return;
  }
  deliverIncomingProtocolMessage(pi, message, true);
}

async function handleIncomingRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  role: PairRole,
  message: PairMessageV2,
): Promise<void> {
  registerInboundRequest(message);
  if (role === "planner" && message.from === "builder") {
    await rememberPendingClarification(pi, ctx, pendingClarificationFromMessage(message, "live", true, message.id));
  }
  deliverIncomingProtocolMessage(pi, message, true);
  promptForReply(pi, message);
}

function createCommandFailureReply(role: PairRole, message: PairMessageV2, error: Error): PairMessageV2 {
  return createMessage({
    type: "reply",
    from: role,
    to: pairedRole(role),
    pairId: message.pairId,
    replyTo: message.id,
    ok: false,
    error: error.message,
    handoffId: message.handoffId,
    body: error.message,
  });
}

async function handleIncomingCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  role: PairRole,
  message: PairMessageV2,
  sourceSocket?: Socket,
): Promise<void> {
  const socket = activeSocketForRole(role);
  if (!socket) throw new Error("No active socket available for command reply.");
  try {
    const reply = role === "builder"
      ? await handleBuilderCommand(pi, ctx, message, sourceSocket)
      : await handlePlannerCommand(pi, ctx, message);
    sendProtocolMessage(socket, reply);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    sendProtocolMessage(socket, createCommandFailureReply(role, message, err));
  }
}

async function handleIncomingMessage(pi: ExtensionAPI, message: PairMessageV2, sourceSocket?: Socket): Promise<void> {
  const ctx = requireLatestPairContext();
  const role = currentPairRole();
  if (message.to !== role) throw new Error(`Unexpected destination '${message.to}' for role '${role}'.`);

  if (role === "builder" && message.type === "command" && message.name === "attach") {
    await handleBuilderAttachCommand(pi, ctx, message, sourceSocket);
    return;
  }

  if (!activeConnectionMatches(role, message, sourceSocket)) {
    throw new Error(`Wrong pairId ${message.pairId} for active connection.`);
  }

  if (message.type === "reply") {
    handleIncomingReply(pi, ctx, role, message);
    return;
  }

  if (message.type === "event") {
    await handleIncomingEvent(pi, ctx, role, message);
    return;
  }

  if (message.type === "request") {
    await handleIncomingRequest(pi, ctx, role, message);
    return;
  }

  if (message.type === "command") {
    await handleIncomingCommand(pi, ctx, role, message, sourceSocket);
  }
}

async function sendOneWayEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: { name: string; body: string; handoffId?: string; payload?: unknown; autoStart: boolean },
): Promise<{ ok: true; action: "message"; pairId: string; to: PairRole; name: string; handoffId?: string; queued?: boolean }> {
  const role = currentPairRole();
  const runtime = await resolveRuntimeContext(pi, ctx);
  const socket = role === "planner"
    ? (await ensurePlannerConnection(pi, ctx, { autoStart: params.autoStart })).socket
    : activeSocketForRole("builder");

  const message = createMessage({
    type: "event",
    from: role,
    to: pairedRole(role),
    pairId: runtime.pairId,
    name: params.name,
    body: params.body,
    ...(params.payload !== undefined ? { payload: params.payload } : {}),
    handoffId: params.handoffId,
  });

  if (role === "builder" && (!socket || socket.destroyed)) {
    await enqueueBuilderEvent(runtime.protocolDir, message);
    return { ok: true, action: "message", pairId: runtime.pairId, to: message.to, name: params.name, handoffId: params.handoffId, queued: true };
  }
  if (!socket) {
    throw new Error("Builder is not currently attached to an active planner connection.");
  }

  const queued = role === "builder"
    ? await deliverBuilderEvent(runtime.protocolDir, socket, message)
    : (sendProtocolMessage(socket, message), false);
  return { ok: true, action: "message", pairId: runtime.pairId, to: message.to, name: params.name, handoffId: params.handoffId, ...(queued ? { queued: true } : {}) };
}

async function sendAskAction(pi: ExtensionAPI, ctx: ExtensionContext, name: string | undefined, text: string): Promise<unknown> {
  const role = currentPairRole();
  const runtime = await resolveRuntimeContext(pi, ctx);
  const socket = role === "planner"
    ? (await ensurePlannerConnection(pi, ctx, { autoStart: true })).socket
    : activeSocketForRole("builder");

  if (role === "builder" && (!socket || socket.destroyed)) {
    const handoffId = rt.pendingBuilderHandoff?.id;
    if (!handoffId) {
      throw new Error("builder ask fallback requires an active handoff id so the durable clarification can be tracked.");
    }
    const defaults = currentBuilderExecutionUpdateDefaults();
    const fallbackPayload = buildExecutionUpdatePayload({
      status: "clarification_needed",
      handoffId,
      summary: text,
      question: text,
      nextStep: "Planner must answer the clarification before execution can continue.",
      ...(defaults.handoffArtifactPath ? { handoffArtifactPath: defaults.handoffArtifactPath } : {}),
      ...(defaults.handoffArtifactSha256 ? { handoffArtifactSha256: defaults.handoffArtifactSha256 } : {}),
    });
    const fallback = await sendOneWayEvent(pi, ctx, {
      name: "clarification_needed",
      body: fallbackPayload.summary,
      handoffId,
      payload: fallbackPayload,
      autoStart: false,
    });
    await rememberPendingClarification(pi, ctx, clarificationStateFromExecutionUpdate(fallbackPayload, "durable", false));
    return {
      ok: true,
      action: "ask",
      pairId: runtime.pairId,
      name,
      fallback: "clarification_needed",
      ...(fallback.queued ? { queued: true } : {}),
    };
  }

  if (!socket) {
    throw new Error("Builder is not currently attached to an active planner connection.");
  }

  const message = createMessage({
    type: "request",
    from: role,
    to: pairedRole(role),
    pairId: runtime.pairId,
    name,
    body: text,
    ...(role === "builder" && rt.pendingBuilderHandoff?.id ? { handoffId: rt.pendingBuilderHandoff.id } : {}),
  });
  const builderClarification = role === "builder"
    ? pendingClarificationFromMessage(message, "live", true, message.id)
    : undefined;
  if (builderClarification) {
    await rememberPendingClarification(pi, ctx, builderClarification);
  }

  try {
    const reply = await startRpc(message, socket);
    if (builderClarification) {
      await clearPendingClarification(pi, ctx);
    }
    if (!reply.ok) throw new Error(reply.error ?? reply.body ?? `Request '${name ?? message.id}' failed.`);
    return { ok: true, action: "ask", pairId: runtime.pairId, name, reply };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (builderClarification) {
      if (/timed out/i.test(err.message)) {
        await rememberPendingClarification(pi, ctx, {
          ...builderClarification,
          replyTo: undefined,
          canReplyNow: false,
        });
      } else {
        await clearPendingClarification(pi, ctx);
      }
    }
    throw err;
  }
}

async function sendCommandAction(pi: ExtensionAPI, ctx: ExtensionContext, name: string, text: string): Promise<unknown> {
  if (currentPairRole() !== "planner") {
    throw new Error("planner_builder({ action: \"command\", ... }) is only implemented from the planner to the builder.");
  }

  const connection = await ensurePlannerConnection(pi, ctx, { autoStart: true });
  const payload = name === "model"
    ? { ref: text.trim() }
    : name === "thinking"
      ? { level: text.trim() }
      : name === "slash_command"
        ? { command: text.trim() }
        : undefined;
  const message = createMessage({
    type: "command",
    from: "planner",
    to: "builder",
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
  const socket = role === "planner"
    ? (await ensurePlannerConnection(pi, ctx, { autoStart: true })).socket
    : activeSocketForRole("builder");
  if (!socket) throw new Error("Builder is not currently attached to an active planner connection.");

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
  if (role === "planner" && pending.from === "builder") {
    await clearPendingClarification(pi, ctx);
  }
  return { ok: true, action: "reply", pairId: runtime.pairId, replyTo };
}

async function sendMessageAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rawMessage: string | undefined,
  name?: string,
  rawPayload?: unknown,
): Promise<unknown> {
  const role = currentPairRole();
  const trimmed = (rawMessage ?? "").trim();
  const pendingHandoffId = role === "builder" ? rt.pendingBuilderHandoff?.id : undefined;
  const inferredName = name?.trim() || (role === "builder" ? inferBuilderEventName(trimmed, rt.pendingBuilderHandoff) : "message");

  let body = trimmed;
  let payload = rawPayload;
  let handoffId = pendingHandoffId;

  if (role === "builder" && isHighSignalBuilderEvent(inferredName)) {
    const structured = normalizeBuilderExecutionUpdatePayload(inferredName, rawPayload);
    body = structured.summary;
    payload = structured;
    handoffId = structured.handoffId;
  } else if (!body) {
    throw new Error("message text is required for non-structured events");
  }

  const result = await sendOneWayEvent(pi, ctx, {
    name: inferredName,
    body,
    handoffId,
    payload,
    autoStart: false,
  });

  if (role === "builder" && inferredName === "clarification_needed" && payload) {
    const structured = payload as ExecutionUpdatePayload;
    await rememberPendingClarification(pi, ctx, clarificationStateFromExecutionUpdate(structured, "durable", false));
  }
  if (role === "builder" && isTerminalSupervisionEvent(inferredName)) {
    await clearPendingClarification(pi, ctx);
    rt.pendingBuilderHandoff = undefined;
  }
  return result;
}

function formatBuildQueuedMarkdown(
  builder: BuilderStatus,
  pairId: string,
  handoffId: string,
  artifactPath: string,
  artifactSha256: string,
): string {
  return [
    `**builder build delegated**`,
    "",
    `- planner mode: ${rt.modeEnabled ? "on" : "off"}`,
    `- pair id: ${pairId}`,
    `- builder name: ${builder.agentName}`,
    `- builder running: ${builder.running ? "yes" : "no"}`,
    `- builder session: ${builder.tmuxSession}`,
    `- handoff id: ${handoffId}`,
    `- handoff artifact: ${artifactPath}`,
    `- handoff sha256: ${artifactSha256}`,
    `- paired transport: protocol-v2 builder socket`,
  ].join("\n");
}

async function handleBuildDelegation(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  if (!rt.modeEnabled) {
    throw new Error("planner-builder mode is off. Run /plan on before using /builder build.");
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.hasUI && ctx.ui.notify("Wait for the planner to finish its current turn before delegating with /builder build.", "warning");
    return;
  }

  const cwd = getContextCwd(ctx);
  const plannerSession = getPlannerSessionBinding(ctx);
  const { settings } = await refreshSettings(cwd);
  const handoffId = randomUUID();
  const handoff = buildHandoffText(ctx, args, handoffId);
  if (!handoff) {
    ctx.hasUI && ctx.ui.notify("No recent planner context found. Ask the planner first or pass explicit instructions to /builder build.", "error");
    return;
  }

  await resolvePlannerSupervisionModel(ctx);

  let builder = await getBuilderStatus(pi, cwd, settings, plannerSession);
  if (!builder.running) {
    builder = await startBuilder(pi, cwd, settings, plannerSession);
    updateStatusLine(ctx, builder);
  }

  const runtime = await resolveRuntimeContext(pi, ctx);
  const handoffArtifact = await writeHandoffArtifact(runtime.runtimeDir, handoffId, handoff);
  const { artifactPath, artifactSha256, artifactBytes } = handoffArtifact;
  const handoffSummary = truncate(handoff, 500);
  const handoffPointer = buildHandoffPointerText({
    handoffId,
    artifactPath,
    artifactSha256,
    summary: handoffSummary,
  });

  const connection = await ensurePlannerConnection(pi, ctx, { autoStart: true });
  const supervised: ActiveSupervisedHandoff = {
    id: handoffId,
    spec: handoff,
    outcome: handoffSummary,
    artifactPath,
    artifactSha256,
    steerCount: 0,
    recentEvents: [],
    pendingEvents: [],
    supervisionRunning: false,
  };
  rt.activeSupervisedHandoff = supervised;

  try {
    const command = createMessage({
      type: "command",
      from: "planner",
      to: "builder",
      pairId: connection.pairId,
      name: "handoff",
      handoffId,
      body: handoffPointer,
      payload: {
        handoffId,
        artifactPath,
        artifactSha256,
        artifactBytes,
        summary: handoffSummary,
      },
    });
    const reply = await startRpc(command, connection.socket);
    if (!reply.ok) throw new Error(reply.error ?? reply.body ?? `Builder rejected handoff ${handoffId}.`);
    await clearPendingClarification(pi, ctx);

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

  emitInfo(
    pi,
    formatBuildQueuedMarkdown(
      builder,
      connection.pairId,
      handoffId,
      artifactPath,
      artifactSha256,
    ),
    BUILD_HANDOFF_MESSAGE_TYPE,
  );
}

type BuilderInterruptState = { tmuxSession: string; tmuxPaneId?: string; agentName?: string };
type BuilderInterruptResolution = { cwd: string; state: BuilderInterruptState };

function isBuilderInterruptState(value: unknown): value is BuilderInterruptState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.tmuxSession === "string" && (state.tmuxPaneId === undefined || typeof state.tmuxPaneId === "string");
}

function tmuxExecSucceeded(result: { code?: number | null }): boolean {
  return (result.code ?? 1) === 0;
}

async function resolveBuilderInterruptState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<BuilderInterruptResolution | null> {
  if (!rt.modeEnabled || currentPairRole() !== "planner") return null;

  const cwd = getContextCwd(ctx);
  const runtime = await resolveRuntimeContext(pi, ctx);
  const statePath = join(runtime.runtimeDir, "builder-state.json");

  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw new Error(`Failed to read builder state file ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isBuilderInterruptState(parsed)) {
    throw new Error(`Invalid builder state file ${statePath}: missing tmuxSession`);
  }

  const hasSession = await pi.exec("tmux", ["has-session", "-t", parsed.tmuxSession], { cwd, timeout: 5_000 });
  if (!tmuxExecSucceeded(hasSession)) return null;
  return { cwd, state: parsed };
}

async function interruptBuilderIfRunning(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  const resolved = await resolveBuilderInterruptState(pi, ctx);
  if (!resolved) return false;

  const { cwd, state } = resolved;
  const target = state.tmuxPaneId?.trim() || `${state.tmuxSession}:0.0`;
  const sent = await pi.exec("tmux", ["send-keys", "-t", target, "C-c"], { cwd, timeout: 5_000 });
  if (!tmuxExecSucceeded(sent)) {
    throw new Error(sent.stderr?.trim() || sent.stdout?.trim() || `Failed to interrupt builder pane ${target}`);
  }

  const agentName = state.agentName?.trim() || "builder";
  ctx.hasUI && ctx.ui.notify(`Sent interrupt to ${agentName} (${target}).`, "warning");
  return true;
}

async function ensureBuilderServer(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (currentPairRole() !== "builder") return;
  const runtime = await resolveRuntimeContext(pi, ctx);
  if (rt.builderServer && rt.builderServerSocketPath === runtime.socketPath) return;

  if (rt.builderServer) {
    await new Promise<void>((resolve) => rt.builderServer?.close(() => resolve()));
    rt.builderServer = undefined;
    rt.builderServerSocketPath = undefined;
    rt.builderServerPairId = undefined;
    rt.activePlannerSocket = undefined;
    rt.activePlannerSessionId = undefined;
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
          console.warn("[planner-builder] builder protocol failed:", err);
          socket.destroy(err);
        });
      },
      (error) => {
        console.warn("[planner-builder] builder protocol failed:", error);
        socket.destroy(error);
      },
    );

    socket.on("data", reader);
    socket.on("close", () => {
      if (rt.activePlannerSocket === socket) {
        rt.activePlannerSocket = undefined;
        rt.activePlannerSessionId = undefined;
      }
    });
    socket.on("error", () => {
      if (rt.activePlannerSocket === socket) {
        rt.activePlannerSocket = undefined;
        rt.activePlannerSessionId = undefined;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.socketPath, () => resolve());
  });

  rt.builderServer = server;
  rt.builderServerSocketPath = runtime.socketPath;
  rt.builderServerPairId = runtime.pairId;
}

export default function plannerBuilderExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Planner Builder",
    description:
      "Manage planner-builder mode and the current repo-scoped builder configured by planner-builder-settings.yaml. " +
      "Actions: start, on, status, off, stop, message, ask, command, reply. " +
      "Control actions start/on/status/off/stop are planner-only: start spawns the builder without changing mode; on enables no-direct-repo-edit planner mode, switches the planner to the configured planning model, and starts the builder if needed; off restores normal planner behavior and restores the previous model/thinking while leaving the builder alone; stop forcibly terminates the builder and, if planner-builder mode is on, also returns the planner to normal mode; message sends a one-way paired event from either side and may include a structured payload; ask sends a blocking paired request from the planner or an attached builder; command sends a blocking operational command from the planner to the builder; reply answers a pending paired request. Builder high-signal events (completed/failed/cancelled/blocker/clarification_needed) require a structured execution-update payload. For planner-side builder inspection and direct builder slash commands, use /builder.",
    parameters: Type.Object({
      action: StringEnum(["start", "on", "status", "off", "stop", "message", "ask", "command", "reply"] as const, {
        description: "Planner-builder control or communication action",
      }),
      name: Type.Optional(Type.String({ description: "Required for action='command'. Optional event/request name for action='message' or action='ask'." })),
      message: Type.Optional(Type.String({ description: "Required for 'ask' and 'reply'. For 'message', required for generic events and used as the short summary for structured execution updates." })),
      payload: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional structured payload for action='message'. Required for builder high-signal events: completed, failed, cancelled, blocker, clarification_needed." })),
      replyTo: Type.Optional(Type.String({ description: "Required for action='reply'. The pending request id to answer." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (params.action === "message") {
          const result = await sendMessageAction(pi, ctx, params.message, params.name, params.payload);
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

        const status = await runControlAction(pi, ctx, params.action, maybePrimePlannerConnection);
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
    if (currentPairRole() !== "planner") {
      ctx.hasUI && ctx.ui.notify("/plan is only available from the planner session.", "error");
      return;
    }

    let action: PlannerBuilderControlAction | null = null;
    try {
      action = await resolveCommandAction(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`planner-builder failed: ${message}`, "error");
      return;
    }

    if (!action) {
      ctx.hasUI && ctx.ui.notify(usage, "error");
      return;
    }

    try {
      const status = await runControlAction(pi, ctx, action, maybePrimePlannerConnection);
      emitInfo(pi, formatStatusMarkdown(status), BUILD_HANDOFF_MESSAGE_TYPE);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`planner-builder failed: ${message}`, "error");
    }
  }

  async function handleBuilderSlashCommand(args: string, ctx: ExtensionContext) {
    const usage = "Usage: /builder status | /builder build [instructions] | /builder /<command> [args]";
    if (currentPairRole() !== "planner") {
      ctx.hasUI && ctx.ui.notify("/builder is only available from the planner session.", "error");
      return;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      ctx.hasUI && ctx.ui.notify(usage, "error");
      return;
    }

    try {
      if (trimmed === "status") {
        emitInfo(pi, await queryBuilderStatusPassive(pi, ctx, ensurePlannerConnection, startRpc), BUILD_HANDOFF_MESSAGE_TYPE);
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
          "**builder command**",
          "",
          `- command: ${trimmed}`,
          ...(reply?.body ? [`- result: ${reply.body}`] : []),
        ].join("\n"),
        BUILD_HANDOFF_MESSAGE_TYPE,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`builder command failed: ${message}`, "error");
    }
  }

  pi.registerCommand("plan", {
    description: "Control planner-builder mode and the current builder: /plan [start|on|status|off|stop] (bare command toggles mode; on switches the planner model, off restores it, stop also exits planner-builder mode if it is on)",
    handler: async (args, ctx) => handleControlCommand(args, ctx, "Usage: /plan [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("builder", {
    description: "Inspect the paired builder, delegate execution, or run a registered slash command inside it: /builder status | /builder build [instructions] | /builder /<command> [args]",
    handler: async (args, ctx) => {
      await handleBuilderSlashCommand(args, ctx);
    },
  });

  pi.registerCommand("abort", {
    description: "Abort the current planner turn, or when planner-builder mode is on and the builder is running, send Ctrl+C to the paired builder's active tmux pane.",
    handler: async (_args, ctx) => {
      try {
        if (await interruptBuilderIfRunning(pi, ctx)) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI && ctx.ui.notify(`builder interrupt failed during /abort: ${message}; aborting planner turn instead.`, "error");
      }
      await ctx.abort();
    },
  });

  pi.on("tool_call", async (event) => {
    if (!rt.modeEnabled) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      return { block: true, reason: `planner-builder mode is on: the planner should avoid direct repo edits. Use /builder build to delegate execution to ${builderSessionReference()}.` };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isSafePlannerBash(command)) {
        return { block: true, reason: `planner-builder mode is on: obvious repo-mutating bash is blocked for the planner. Use /builder build to delegate execution to ${builderSessionReference()}.\nCommand: ${command}` };
      }
    }

    if (event.toolName === TOOL_NAME) {
      const action = typeof event.input.action === "string" ? event.input.action : "";
      if (!["message", "ask", "command", "reply"].includes(action)) {
        return {
          block: true,
          reason: `planner-builder mode is on: builder lifecycle control should go through explicit slash commands (/plan, /builder). Allowed tool calls are planner_builder communication actions: message, ask, command, and reply.`,
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
      "You are the planner half of a planner→builder workflow.",
      "",
      "Planner rules:",
      "- Do not directly edit repository files from the planner.",
      "- Bash is available for broad inspection/prep work, but avoid obvious repo-mutating commands.",
      "- Focus on understanding the codebase, producing plans, reviewing results, and preparing precise builder instructions.",
      "- Send intent/spec to the builder, not implementation code. Do not send concrete code snippets, patches, or copy-paste-ready blocks.",
      "- When the user wants execution, they will run /builder build to delegate the current plan to the repo-scoped builder.",
      '- You may communicate with the paired builder using planner_builder({ action: "message" | "ask" | "command" | "reply", ... }).',
      "- The paired builder may also message you or ask direct clarification questions. Answer only when it materially helps execution.",
      "- Prefer concise builder handoff packets with: goal, relevant files, implementation steps, and validation.",
    ];

    const plannerPromptAppend = plannerConfig().prompt_append;
    if (plannerPromptAppend) lines.push("", plannerPromptAppend);

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
    rt.lastObservedPlannerModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
    await restoreModeState(pi, ctx).catch((err) => {
      console.warn("[planner-builder] restoreModeState failed:", err);
      notify(ctx, `planner-builder restore failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    });
    if (currentPairRole() === "builder") {
      await ensureBuilderServer(pi, ctx).catch((err) => {
        console.warn("[planner-builder] ensureBuilderServer failed:", err);
        notify(ctx, `planner-builder builder server failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      });
    } else {
      await maybePrimePlannerConnection(pi, ctx);
    }
    await restorePendingClarificationState(pi, ctx).catch((err) => {
      console.warn("[planner-builder] restorePendingClarificationState failed:", err);
      notify(ctx, `planner-builder clarification restore failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    });
  };

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", async (event) => {
    rt.lastObservedPlannerModel = { provider: event.model.provider, modelId: event.model.id };
  });

  pi.on("turn_end", async (_event, ctx) => {
    rt.latestPairContext = ctx;
    maybeAutoReportBuilderCompletion();
  });
}
