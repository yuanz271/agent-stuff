import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
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
  type LeadSessionBinding,
  type WorkerStatus,
} from "./utils.js";
import {
  loadLeadWorkerSettings,
  type LeadWorkerSettings,
  type LeadWorkerSettingsLoadResult,
  type LeadWorkerSource,
} from "./settings.js";

const STATUS_KEY = "lead-worker";
const TOOL_NAME = "lead_worker";
const STATE_ENTRY_TYPE = "lead-worker-state";
const CONTEXT_MESSAGE_TYPE = "lead-worker-context";
const BUILD_HANDOFF_MESSAGE_TYPE = "lead-worker-handoff";
const PAIR_MESSAGE_TYPE = "lead-worker-pair-message";
const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
const MAX_HANDOFF_CHARS = 32_000;
const WORKER_RELAY_DEDUP_WINDOW_MS = 60_000;
const WORKER_AUTO_REPORT_SUMMARY_MAX_CHARS = 3_000;
const MAX_TRACKED_REPORTED_HANDOFF_IDS = 256;
const SOCKET_WAIT_TIMEOUT_MS = 10_000;
const SOCKET_WAIT_INTERVAL_MS = 100;
const MUTATING_BASH_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
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
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag)\b/i,
  /\bsudo\b/i,
  /\bbash\b/i,
  /\bsh\b/i,
  /\bzsh\b/i,
];
const SAFE_BASH_PREFIXES = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*nvidia-smi\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)\b/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*node\s+--version\b/i,
  /^\s*python\s+--version\b/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n\b/i,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
];

type LeadWorkerControlAction = "start" | "on" | "status" | "off" | "stop";
type CommunicationAction = "message" | "ask" | "command" | "reply";
type LeadWorkerAction = LeadWorkerControlAction | CommunicationAction;

type LeadSelection = {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

type PersistedLeadWorkerState = {
  enabled: boolean;
  previousActiveTools?: string[];
  previousLeadSelection?: LeadSelection;
  updatedAt: string;
};

type ExtractedMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type LeadWorkerStatus = {
  ok: true;
  action: LeadWorkerControlAction;
  modeEnabled: boolean;
  leadReadOnly: boolean;
  message: string;
  activeTools: string[];
  previousActiveTools?: string[];
  leadModel?: string;
  leadThinkingLevel: ThinkingLevel;
  configuredLeadModel: string;
  configuredLeadThinkingLevel: ThinkingLevel;
  previousLeadModel?: string;
  previousLeadThinkingLevel?: ThinkingLevel;
  settingsSources: LeadWorkerSource[];
  settingsWarnings: string[];
  settingsInvalidFieldCount: number;
  worker: WorkerStatus;
};

type PendingRpc = {
  resolve: (message: PairMessageV2) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingInboundRequest = {
  from: PairRole;
  name?: string;
  receivedAtMs: number;
};

type ActiveConnection = {
  socket: Socket;
  pairId: string;
  socketPath: string;
  projectRoot: string;
  leadSessionId: string;
};

type PendingWorkerHandoff = {
  id: string;
  receivedAtMs: number;
  pairId: string;
};

interface LeadWorkerRuntime {
  modeEnabled: boolean;
  previousActiveTools: string[] | undefined;
  previousLeadSelection: LeadSelection | undefined;
  lastObservedLeadModel: { provider?: string; modelId?: string };
  currentSettings: LeadWorkerSettingsLoadResult | undefined;
  latestPairContext: ExtensionContext | undefined;
  pendingWorkerHandoff: PendingWorkerHandoff | undefined;
  lastOutboundProtocolAtMs: number | undefined;
  lastWorkerRelayFingerprint: string | undefined;
  lastWorkerRelayAtMs: number | undefined;
  reportedWorkerHandoffIds: Set<string>;
  pendingRpc: Map<string, PendingRpc>;
  expiredRpcIds: Set<string>;
  pendingInboundRequests: Map<string, PendingInboundRequest>;
  activeConnection: ActiveConnection | undefined;
  connectPromise: Promise<ActiveConnection> | undefined;
  connectionError: string | undefined;
  workerServer: Server | undefined;
  workerServerSocketPath: string | undefined;
  workerServerPairId: string | undefined;
  activeLeadSocket: Socket | undefined;
  activeLeadSessionId: string | undefined;
}

const rt: LeadWorkerRuntime = {
  modeEnabled: false,
  previousActiveTools: undefined,
  previousLeadSelection: undefined,
  lastObservedLeadModel: {},
  currentSettings: undefined,
  latestPairContext: undefined,
  pendingWorkerHandoff: undefined,
  lastOutboundProtocolAtMs: undefined,
  lastWorkerRelayFingerprint: undefined,
  lastWorkerRelayAtMs: undefined,
  reportedWorkerHandoffIds: new Set<string>(),
  pendingRpc: new Map<string, PendingRpc>(),
  expiredRpcIds: new Set<string>(),
  pendingInboundRequests: new Map<string, PendingInboundRequest>(),
  activeConnection: undefined,
  connectPromise: undefined,
  connectionError: undefined,
  workerServer: undefined,
  workerServerSocketPath: undefined,
  workerServerPairId: undefined,
  activeLeadSocket: undefined,
  activeLeadSessionId: undefined,
};

function normalizeControlAction(raw: string): LeadWorkerControlAction | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (value === "start") return "start";
  if (value === "on") return "on";
  if (value === "status") return "status";
  if (value === "off") return "off";
  if (value === "stop") return "stop";
  return null;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && "type" in block && "text" in block && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function getMessagesSinceLastUser(ctx: ExtensionContext): ExtractedMessage[] {
  const branch = ctx.sessionManager.getBranch();
  let lastUserIndex = -1;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && "role" in entry.message && entry.message.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) return [];

  const extracted: ExtractedMessage[] = [];
  for (let i = lastUserIndex; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!("role" in msg) || (msg.role !== "user" && msg.role !== "assistant")) continue;
    const text = extractTextContent(msg.content);
    if (!text) continue;

    extracted.push({
      role: msg.role,
      content: truncate(text, MAX_CONTEXT_MESSAGE_CHARS),
      timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
    });
  }

  return extracted;
}

function stripBenignRedirects(command: string): string {
  return command
    .replace(/(^|[\s;|&])(?:[12]?>\s*\/dev\/null)(?=$|[\s;|&])/gi, "$1")
    .replace(/(^|[\s;|&])(?:[12]?>&[12])(?=$|[\s;|&])/g, "$1");
}

function isSafeLeadBash(command: string): boolean {
  const commandForMutatingChecks = stripBenignRedirects(command);
  const destructive = MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(commandForMutatingChecks));
  const safe = SAFE_BASH_PREFIXES.some((pattern) => pattern.test(command));
  return safe && !destructive;
}

function requireCurrentSettings(): LeadWorkerSettingsLoadResult {
  if (!rt.currentSettings) {
    throw new Error("lead-worker settings are not loaded");
  }
  return rt.currentSettings;
}

function workerSessionReference(): string {
  return "the paired worker session";
}

function leadConfig(): LeadWorkerSettings["lead"] {
  return requireCurrentSettings().settings.lead;
}

function getConfiguredLeadSelection(settings: LeadWorkerSettings = requireCurrentSettings().settings): LeadSelection | undefined {
  const ref = settings.lead.model.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator >= ref.length - 1) return undefined;
  return {
    provider: ref.slice(0, separator),
    modelId: ref.slice(separator + 1),
    thinkingLevel: settings.lead.thinking,
  };
}

async function refreshSettings(cwd: string): Promise<LeadWorkerSettingsLoadResult> {
  rt.currentSettings = await loadLeadWorkerSettings(cwd, import.meta.url);
  return rt.currentSettings;
}

function currentPairRole(): PairRole {
  return process.env.PI_LEAD_WORKER_ROLE === "worker" ? "worker" : "lead";
}

function pairedRole(role: PairRole): PairRole {
  return role === "lead" ? "worker" : "lead";
}

function getLeadSessionBinding(ctx: ExtensionContext): LeadSessionBinding {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
  };
}

function validToolNames(pi: ExtensionAPI): Set<string> {
  return new Set(pi.getAllTools().map((tool) => tool.name));
}

function filterLeadTools(pi: ExtensionAPI, sourceTools: string[]): string[] {
  const valid = validToolNames(pi);
  const allowed = new Set(leadConfig().allowed_tools);
  if (valid.has(TOOL_NAME)) {
    allowed.add(TOOL_NAME);
  }
  const filtered = sourceTools.filter((name, index) => sourceTools.indexOf(name) === index && valid.has(name) && allowed.has(name));
  if (filtered.length > 0) return filtered;
  return Array.from(valid).filter((name) => allowed.has(name));
}

function normalizeToolList(pi: ExtensionAPI, sourceTools: string[] | undefined): string[] {
  if (!sourceTools || sourceTools.length === 0) return [];
  const valid = validToolNames(pi);
  return sourceTools.filter((name, index) => sourceTools.indexOf(name) === index && valid.has(name));
}

function normalizeLeadSelection(selection: LeadSelection | undefined): LeadSelection | undefined {
  if (!selection) return undefined;
  const provider = typeof selection.provider === "string" && selection.provider.trim() ? selection.provider.trim() : undefined;
  const modelId = typeof selection.modelId === "string" && selection.modelId.trim() ? selection.modelId.trim() : undefined;
  const thinkingLevel = selection.thinkingLevel;
  if (!provider && !modelId && !thinkingLevel) return undefined;
  return { provider, modelId, thinkingLevel };
}

function formatLeadModel(selection: LeadSelection | undefined): string | undefined {
  if (!selection?.provider || !selection.modelId) return undefined;
  return `${selection.provider}/${selection.modelId}`;
}

function getCurrentLeadSelection(pi: ExtensionAPI, ctx: ExtensionContext): LeadSelection {
  return {
    provider: rt.lastObservedLeadModel.provider ?? ctx.model?.provider,
    modelId: rt.lastObservedLeadModel.modelId ?? ctx.model?.id,
    thinkingLevel: pi.getThinkingLevel(),
  };
}

async function applyLeadSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection: LeadSelection | undefined,
): Promise<string | undefined> {
  const normalized = normalizeLeadSelection(selection);
  if (!normalized) return undefined;

  let warning: string | undefined;

  if (normalized.provider && normalized.modelId) {
    const model = ctx.modelRegistry.find(normalized.provider, normalized.modelId);
    if (!model) {
      warning = `Model ${normalized.provider}/${normalized.modelId} is not available in the local registry.`;
    } else {
      const ok = await pi.setModel(model);
      if (!ok) {
        warning = `No API key available for ${normalized.provider}/${normalized.modelId}.`;
      } else {
        rt.lastObservedLeadModel = { provider: normalized.provider, modelId: normalized.modelId };
      }
    }
  }

  if (normalized.thinkingLevel) {
    pi.setThinkingLevel(normalized.thinkingLevel);
  }

  return warning;
}

function persistModeState(pi: ExtensionAPI): void {
  pi.appendEntry<PersistedLeadWorkerState>(STATE_ENTRY_TYPE, {
    enabled: rt.modeEnabled,
    previousActiveTools: rt.previousActiveTools,
    previousLeadSelection: rt.previousLeadSelection,
    updatedAt: new Date().toISOString(),
  });
}

function restorePersistedState(ctx: ExtensionContext): PersistedLeadWorkerState | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as PersistedLeadWorkerState | undefined;
    if (!data || typeof data.enabled !== "boolean") continue;
    return {
      enabled: data.enabled,
      previousActiveTools: Array.isArray(data.previousActiveTools) ? data.previousActiveTools.filter((name) => typeof name === "string") : undefined,
      previousLeadSelection: normalizeLeadSelection(data.previousLeadSelection),
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    };
  }
  return undefined;
}

function restoreNormalTools(pi: ExtensionAPI, savedTools: string[] | undefined): void {
  const normalized = normalizeToolList(pi, savedTools);
  if (normalized.length > 0) {
    pi.setActiveTools(normalized);
  }
}

function applyLeadMode(pi: ExtensionAPI): void {
  if (!rt.modeEnabled) return;
  if (!rt.previousActiveTools || rt.previousActiveTools.length === 0) {
    rt.previousActiveTools = pi.getActiveTools();
  }
  pi.setActiveTools(filterLeadTools(pi, rt.previousActiveTools));
}

function renderSummary(worker: WorkerStatus): string | undefined {
  if (!rt.modeEnabled && !worker.running) return undefined;
  const workerPart = worker.running ? `${worker.agentName}:on` : `${worker.agentName}:off`;
  if (!rt.modeEnabled) return workerPart;
  return `lead:on | ${workerPart}`;
}

function updateStatusLine(ctx: ExtensionContext, worker: WorkerStatus): void {
  if (!ctx.hasUI) return;
  const summary = renderSummary(worker);
  if (!summary) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  if (rt.modeEnabled) {
    const leadPart = theme.fg("warning", "lead:on");
    const workerPart = worker.running
      ? theme.fg("accent", `${worker.agentName}:on`)
      : theme.fg("muted", `${worker.agentName}:off`);
    ctx.ui.setStatus(STATUS_KEY, `${leadPart} | ${workerPart}`);
    return;
  }

  const workerPart = worker.running
    ? theme.fg("accent", `${worker.agentName}:on`)
    : theme.fg("muted", `${worker.agentName}:off`);
  ctx.ui.setStatus(STATUS_KEY, workerPart);
}

function buildStatus(action: LeadWorkerControlAction, message: string, worker: WorkerStatus, pi: ExtensionAPI): LeadWorkerStatus {
  const leadModel = formatLeadModel({
    provider: rt.lastObservedLeadModel.provider,
    modelId: rt.lastObservedLeadModel.modelId,
  });
  const previousLeadModel = formatLeadModel(rt.previousLeadSelection);
  const loadedSettings = requireCurrentSettings();

  return {
    ok: true,
    action,
    modeEnabled: rt.modeEnabled,
    leadReadOnly: rt.modeEnabled,
    message,
    activeTools: pi.getActiveTools(),
    previousActiveTools: rt.previousActiveTools,
    leadModel,
    leadThinkingLevel: pi.getThinkingLevel(),
    configuredLeadModel: loadedSettings.settings.lead.model,
    configuredLeadThinkingLevel: loadedSettings.settings.lead.thinking,
    previousLeadModel,
    previousLeadThinkingLevel: rt.previousLeadSelection?.thinkingLevel,
    settingsSources: loadedSettings.stats.loaded_sources,
    settingsWarnings: loadedSettings.warnings,
    settingsInvalidFieldCount: loadedSettings.stats.invalid_field_count,
    worker,
  };
}

function formatStatusMarkdown(status: LeadWorkerStatus): string {
  const lines = [
    `**lead-worker ${status.action}**`,
    "",
    `- message: ${status.message}`,
    `- lead mode: ${status.modeEnabled ? "on" : "off"}`,
    `- lead behavior: ${status.leadReadOnly ? "lead (read-only)" : "normal"}`,
    `- lead model: ${status.leadModel ?? "unknown"}`,
    `- lead thinking: ${status.leadThinkingLevel}`,
    `- configured lead model: ${status.configuredLeadModel}`,
    `- configured lead thinking: ${status.configuredLeadThinkingLevel}`,
    `- active tools: ${status.activeTools.length > 0 ? status.activeTools.join(", ") : "(none)"}`,
  ];

  if (status.previousLeadModel) {
    lines.push(`- restore model on off: ${status.previousLeadModel}`);
  }
  if (status.previousLeadThinkingLevel) {
    lines.push(`- restore thinking on off: ${status.previousLeadThinkingLevel}`);
  }

  lines.push(
    "",
    "**settings**",
    "",
    `- loaded sources: ${status.settingsSources.map((source) => `${source.kind}:${source.path}`).join(", ")}`,
    `- invalid fields ignored: ${status.settingsInvalidFieldCount}`,
    "",
    "**worker**",
    "",
    `- running: ${status.worker.running ? "yes" : "no"}`,
    `- name: ${status.worker.agentName}`,
    `- pair id: ${status.worker.pairId}`,
    `- model: ${status.worker.model}`,
    `- thinking: ${status.worker.thinking}`,
    ...(status.worker.leadSessionId ? [`- last lead session id: ${status.worker.leadSessionId}`] : []),
    `- tmux session: ${status.worker.tmuxSession}`,
    `- session file: ${status.worker.sessionFile}`,
    `- log file: ${status.worker.logFile}`,
    `- launch script: ${status.worker.launchScript}`,
    `- socket path: ${status.worker.socketPath}`,
  );

  if (status.worker.leadSessionFile) lines.push(`- last lead session file: ${status.worker.leadSessionFile}`);
  if (status.worker.startedAt) lines.push(`- started: ${status.worker.startedAt}`);
  if (status.worker.lastStoppedAt) lines.push(`- last stopped: ${status.worker.lastStoppedAt}`);
  if (status.worker.alreadyRunning) lines.push(`- note: existing ${status.worker.agentName} session reused`);

  if (status.settingsWarnings.length > 0 || status.worker.warnings.length > 0) {
    lines.push("", "**warnings**", "");
    for (const warning of status.settingsWarnings) lines.push(`- settings: ${warning}`);
    for (const warning of status.worker.warnings) lines.push(`- ${warning}`);
  }

  if (status.worker.backlog.length > 0) {
    lines.push("", "**recent worker output**", "", "```text", ...status.worker.backlog, "```");
  }

  return lines.join("\n");
}

function emitInfo(pi: ExtensionAPI, markdown: string, customType = BUILD_HANDOFF_MESSAGE_TYPE): void {
  pi.sendMessage(
    {
      customType,
      content: markdown,
      display: true,
    },
    { triggerTurn: false },
  );
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

function sendProtocolMessage(socket: Socket, message: PairMessageV2): void {
  writeMessage(socket, message);
  rt.lastOutboundProtocolAtMs = Date.now();
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

async function connectToWorkerSocket(socketPath: string, timeoutMs = SOCKET_WAIT_TIMEOUT_MS): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    const socket = createConnection(socketPath);
    try {
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

async function enqueueWorkerEvent(protocolDir: string, message: PairMessageV2): Promise<void> {
  const queued = await loadQueuedWorkerEvents(protocolDir);
  queued.push(message);
  await saveQueuedWorkerEvents(protocolDir, queued);
}

async function flushQueuedWorkerEvents(protocolDir: string, socket: Socket, pairId: string): Promise<void> {
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
      const attach = createMessage({
        type: "command",
        from: "lead",
        to: "worker",
        pairId: runtime.pairId,
        name: "attach",
        payload: { leadSessionId: leadSession.sessionId },
        body: `Attach lead session ${leadSession.sessionId}`,
      });
      const attachReply = await startRpc(attach, socket);
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

function normalizeWhitespaceLower(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function pairRelayFingerprint(message: PairMessageV2): string {
  const handoffId = message.handoffId ?? "";
  return `${message.from}|${message.to}|${message.type}|${message.name ?? ""}|${message.pairId}|${handoffId}|${normalizeWhitespaceLower(message.body ?? "")}`;
}

function inferWorkerEventName(text: string, pendingHandoff: PendingWorkerHandoff | undefined): string {
  const normalized = normalizeWhitespaceLower(text);
  if (/\bstatus\s*:\s*(done|completed)\b/i.test(text)) return "completed";
  if (/\bstatus\s*:\s*(failed|cancelled)\b/i.test(text)) return "failed";
  if (/\bstatus\s*:\s*blocked\b/i.test(text)) return "blocker";
  if (/\bclarification\b/i.test(normalized)) return "clarification_needed";
  return pendingHandoff ? "progress" : "message";
}

function rememberReportedWorkerHandoff(handoffId: string): void {
  rt.reportedWorkerHandoffIds.add(handoffId);
  if (rt.reportedWorkerHandoffIds.size <= MAX_TRACKED_REPORTED_HANDOFF_IDS) return;
  const oldest = rt.reportedWorkerHandoffIds.values().next().value;
  if (oldest) rt.reportedWorkerHandoffIds.delete(oldest);
}

function latestAssistantText(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!("role" in msg) || msg.role !== "assistant") continue;
    const text = extractTextContent(msg.content).trim();
    if (text) return text;
  }
  return "";
}

function formatIncomingProtocolMessage(message: PairMessageV2): string {
  const heading = message.type === "event"
    ? `**lead-worker event from ${message.from}: ${message.name ?? "event"}**`
    : message.type === "request"
      ? `**lead-worker request from ${message.from}${message.name ? `: ${message.name}` : ""}**`
      : `**lead-worker message from ${message.from}**`;
  return [
    heading,
    "",
    `- pair id: ${message.pairId}`,
    ...(message.handoffId ? [`- handoff id: ${message.handoffId}`] : []),
    ...(message.replyTo ? [`- reply to: ${message.replyTo}`] : []),
    "",
    message.body ?? "(no body)",
  ].join("\n");
}

function notify(ctx: ExtensionContext | undefined, message: string, severity: "info" | "warning" | "error" = "info"): void {
  if (ctx?.hasUI) ctx.ui.notify(message, severity);
}

function deliverIncomingProtocolMessage(pi: ExtensionAPI, message: PairMessageV2, triggerTurn: boolean): void {
  pi.sendMessage(
    {
      customType: PAIR_MESSAGE_TYPE,
      content: formatIncomingProtocolMessage(message),
      display: true,
      details: message,
    },
    triggerTurn ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false },
  );
}

function promptForReply(pi: ExtensionAPI, message: PairMessageV2): void {
  const instruction = [
    `${message.from === "worker" ? "Worker" : "Lead"} asked a direct question${message.name ? ` (${message.name})` : ""}.`,
    `Reply exactly once with lead_worker({ action: "reply", replyTo: "${message.id}", message: "..." }).`,
    ...(message.handoffId ? [`handoff_id: ${message.handoffId}`] : []),
    "",
    message.body ?? "",
  ].join("\n");
  pi.sendUserMessage(instruction, { deliverAs: "followUp" });
}

function maybeRelayWorkerEventToUser(pi: ExtensionAPI, message: PairMessageV2): void {
  if (currentPairRole() !== "lead" || message.from !== "worker" || message.type !== "event") return;
  if (!["completed", "failed", "cancelled", "blocker", "clarification_needed"].includes(message.name ?? "")) return;

  const handoffId = message.handoffId;
  if (handoffId && rt.reportedWorkerHandoffIds.has(handoffId)) return;

  const now = Date.now();
  const fingerprint = pairRelayFingerprint(message);
  const withinWindow = (rt.lastWorkerRelayAtMs ?? 0) > now - WORKER_RELAY_DEDUP_WINDOW_MS;
  if (withinWindow && rt.lastWorkerRelayFingerprint === fingerprint) return;

  rt.lastWorkerRelayFingerprint = fingerprint;
  rt.lastWorkerRelayAtMs = now;
  if (handoffId) rememberReportedWorkerHandoff(handoffId);

  const relayPrompt = [
    "Worker sent an execution update.",
    "Reply to the USER now with a concise status update.",
    "Include: (1) status, (2) files changed, (3) validation result, (4) next step.",
    ...(handoffId ? ["", `handoff_id: ${handoffId}`] : []),
    "",
    `Worker event (${message.name}):`,
    message.body ?? "",
  ].join("\n");

  pi.sendUserMessage(relayPrompt, { deliverAs: "followUp" });
}

async function maybeAutoReportWorkerCompletion(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (currentPairRole() !== "worker") return;
  const pending = rt.pendingWorkerHandoff;
  if (!pending) return;
  if ((rt.lastOutboundProtocolAtMs ?? 0) >= pending.receivedAtMs) {
    rt.pendingWorkerHandoff = undefined;
    return;
  }

  const summary = latestAssistantText(ctx);
  if (!summary) return;

  const runtime = await resolveRuntimeContext(pi, ctx);
  const message = createMessage({
    type: "event",
    from: "worker",
    to: "lead",
    pairId: pending.pairId,
    name: "completed",
    handoffId: pending.id,
    body: [
      "Worker terminal update (auto):",
      `- handoff_id: ${pending.id}`,
      "- status: completed",
      "- files changed: see latest worker response and diffs",
      "- validation: see latest worker response",
      "- details:",
      truncate(summary, WORKER_AUTO_REPORT_SUMMARY_MAX_CHARS),
    ].join("\n"),
  });

  if (!rt.activeLeadSocket || rt.activeLeadSocket.destroyed) {
    await enqueueWorkerEvent(runtime.protocolDir, message);
  } else {
    sendProtocolMessage(rt.activeLeadSocket, message);
  }
  rt.pendingWorkerHandoff = undefined;
}

async function restoreModeState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await refreshSettings(ctx.cwd ?? process.cwd());

  const restored = restorePersistedState(ctx);
  rt.modeEnabled = restored?.enabled ?? false;
  rt.previousActiveTools = rt.modeEnabled ? restored?.previousActiveTools ?? pi.getActiveTools() : undefined;
  rt.previousLeadSelection = rt.modeEnabled ? restored?.previousLeadSelection : undefined;

  if (rt.modeEnabled) {
    applyLeadMode(pi);
    const warning = await applyLeadSelection(pi, ctx, getConfiguredLeadSelection());
    if (warning && ctx.hasUI) ctx.ui.notify(`lead-worker: ${warning}`, "warning");
  }

  const worker = await getWorkerStatus(
    pi,
    ctx.cwd ?? process.cwd(),
    requireCurrentSettings().settings,
    getLeadSessionBinding(ctx),
  ).catch(() => undefined);
  if (worker) updateStatusLine(ctx, worker);
}

async function startOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: LeadWorkerSettings): Promise<LeadWorkerStatus> {
  const worker = await startWorker(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
  updateStatusLine(ctx, worker);
  if (currentPairRole() === "lead") {
    await ensureLeadConnection(pi, ctx, { autoStart: false, failIfUnavailable: false }).catch(() => undefined);
  }
  return buildStatus("start", worker.message, worker, pi);
}

async function enableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: LeadWorkerSettings): Promise<LeadWorkerStatus> {
  const capturedTools = rt.modeEnabled ? rt.previousActiveTools : pi.getActiveTools();
  const capturedSelection = rt.modeEnabled ? rt.previousLeadSelection : getCurrentLeadSelection(pi, ctx);
  const worker = await startWorker(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
  const configuredSelection = getConfiguredLeadSelection(settings);

  rt.modeEnabled = true;
  rt.previousActiveTools = normalizeToolList(pi, capturedTools);
  if (rt.previousActiveTools.length === 0) rt.previousActiveTools = pi.getActiveTools();
  rt.previousLeadSelection = normalizeLeadSelection(capturedSelection);

  const switchWarning = await applyLeadSelection(pi, ctx, configuredSelection);

  applyLeadMode(pi);
  persistModeState(pi);
  updateStatusLine(ctx, worker);
  await ensureLeadConnection(pi, ctx, { autoStart: false, failIfUnavailable: false }).catch(() => undefined);

  const configuredModelLabel = formatLeadModel(configuredSelection) ?? settings.lead.model;
  const switchMessage = switchWarning
    ? `Lead remained on ${formatLeadModel(getCurrentLeadSelection(pi, ctx)) ?? "the current model"} (${switchWarning})`
    : `Lead switched to ${configuredModelLabel} (${settings.lead.thinking})`;

  return buildStatus(
    "on",
    `Lead-worker mode enabled. Lead is now read-only. ${switchMessage}. ${worker.message}`,
    worker,
    pi,
  );
}

async function restoreLeadMode(pi: ExtensionAPI, ctx: ExtensionContext, worker: WorkerStatus): Promise<string> {
  const toolsToRestore = rt.previousActiveTools;
  const leadToRestore = rt.previousLeadSelection;

  rt.modeEnabled = false;
  restoreNormalTools(pi, toolsToRestore);

  const restoreWarning = await applyLeadSelection(pi, ctx, leadToRestore);

  rt.previousActiveTools = undefined;
  rt.previousLeadSelection = undefined;
  persistModeState(pi);
  updateStatusLine(ctx, worker);

  const restoreTarget = formatLeadModel(leadToRestore);
  return restoreWarning
    ? `Lead model restore was skipped (${restoreWarning})`
    : restoreTarget
      ? `Lead restored to ${restoreTarget}${leadToRestore?.thinkingLevel ? ` (${leadToRestore.thinkingLevel})` : ""}`
      : "Lead returned to its prior model state";
}

async function disableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: LeadWorkerSettings): Promise<LeadWorkerStatus> {
  const worker = await getWorkerStatus(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
  const restoreMessage = await restoreLeadMode(pi, ctx, worker);
  return buildStatus(
    "off",
    `Lead-worker mode disabled. Lead returned to normal mode. ${restoreMessage}. ${worker.running ? `Worker ${worker.agentName} is still running.` : `Worker ${worker.agentName} is not running.`}`,
    worker,
    pi,
  );
}

async function statusOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: LeadWorkerSettings): Promise<LeadWorkerStatus> {
  const worker = await getWorkerStatus(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
  updateStatusLine(ctx, worker);
  return buildStatus(
    "status",
    `Lead-worker mode is ${rt.modeEnabled ? "on" : "off"}. Lead model is ${formatLeadModel(getCurrentLeadSelection(pi, ctx)) ?? "unknown"}. Worker ${worker.agentName} is ${worker.running ? "running" : "not running"}.`,
    worker,
    pi,
  );
}

async function stopOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: LeadWorkerSettings): Promise<LeadWorkerStatus> {
  const worker = await stopWorker(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));

  if (rt.modeEnabled) {
    const restoreMessage = await restoreLeadMode(pi, ctx, worker);
    return buildStatus("stop", `Worker ${worker.agentName} forcibly terminated. Lead-worker mode disabled. ${restoreMessage}.`, worker, pi);
  }

  updateStatusLine(ctx, worker);
  return buildStatus("stop", `Worker ${worker.agentName} forcibly terminated.`, worker, pi);
}

async function runControlAction(pi: ExtensionAPI, ctx: ExtensionContext, action: LeadWorkerControlAction): Promise<LeadWorkerStatus> {
  const { settings } = await refreshSettings(ctx.cwd ?? process.cwd());
  switch (action) {
    case "start": return startOnly(pi, ctx, settings);
    case "on": return enableMode(pi, ctx, settings);
    case "status": return statusOnly(pi, ctx, settings);
    case "off": return disableMode(pi, ctx, settings);
    case "stop": return stopOnly(pi, ctx, settings);
  }
}

async function resolveCommandAction(raw: string): Promise<LeadWorkerControlAction | null> {
  const explicit = normalizeControlAction(raw);
  if (explicit) return explicit;
  if (raw.trim() !== "") return null;
  return rt.modeEnabled ? "off" : "on";
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

function formatWorkerStatusReply(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const cwd = ctx.cwd ?? process.cwd();
  return [
    "Worker status",
    `- cwd: ${cwd}`,
    `- model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
    `- thinking: ${pi.getThinkingLevel()}`,
    ...(rt.pendingWorkerHandoff ? [`- pending handoff id: ${rt.pendingWorkerHandoff.id}`] : []),
  ].join("\n");
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
      body: `Executed worker slash command ${commandText}.`,
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
    throw new Error(`Unexpected reply for unknown request id '${message.replyTo ?? ""}'.`);
  }

  if (message.type === "event") {
    if (currentPairRole() === "lead") {
      const eventName = message.name ?? "event";
      if (eventName === "busy") {
        rt.connectionError = message.body ?? "Worker is already attached to another active lead connection.";
        notify(ctx, rt.connectionError, "error");
      } else if (eventName === "progress" || eventName === "readiness") {
        notify(ctx, message.body ?? `Worker event: ${eventName}`, "info");
      } else {
        deliverIncomingProtocolMessage(pi, message, true);
        maybeRelayWorkerEventToUser(pi, message);
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

  sendProtocolMessage(socket, message);
  return { ok: true, action: "message", pairId: runtime.pairId, to: message.to, name: params.name, handoffId: params.handoffId };
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
  if (role === "worker" && inferredName !== "progress") {
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
    "Implement the agreed plan in the repo-scoped worker. The lead remains read-only.",
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
  if (!rt.modeEnabled) return;
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

  let worker = await getWorkerStatus(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
  if (!worker.running) {
    worker = await startWorker(pi, ctx.cwd ?? process.cwd(), settings, getLeadSessionBinding(ctx));
    updateStatusLine(ctx, worker);
  }

  const connection = await ensureLeadConnection(pi, ctx, { autoStart: true, failIfUnavailable: true });
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
      "start spawns the worker without changing mode; on enables read-only lead mode, switches the lead to the configured planning model, and starts the worker if needed; off restores normal lead behavior and restores the previous model/thinking while leaving the worker alone; stop forcibly terminates the worker and, if lead-worker mode is on, also returns the lead to normal mode; message sends a one-way paired event from either side; ask sends a blocking paired request from the lead or an attached worker; command sends a blocking operational command from the lead to the worker; reply answers a pending paired request. For lead-side worker inspection and direct worker slash commands, use /worker.",
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

        const status = await runControlAction(pi, ctx, params.action);
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
      const status = await runControlAction(pi, ctx, action);
      emitInfo(pi, formatStatusMarkdown(status), BUILD_HANDOFF_MESSAGE_TYPE);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`lead-worker failed: ${message}`, "error");
    }
  }

  async function handleWorkerCommand(args: string, ctx: ExtensionContext) {
    if (currentPairRole() !== "lead") {
      ctx.hasUI && ctx.ui.notify("/worker is only available from the lead session.", "error");
      return;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      ctx.hasUI && ctx.ui.notify("Usage: /worker status | /worker build [instructions] | /worker /<command> [args]", "error");
      return;
    }

    try {
      if (trimmed === "status") {
        const result = await sendCommandAction(pi, ctx, "status", "");
        const reply = (result as { reply?: PairMessageV2 }).reply;
        emitInfo(
          pi,
          [
            "**worker status**",
            "",
            ...(reply?.body ? [reply.body] : [JSON.stringify(result, null, 2)]),
          ].join("\n"),
          BUILD_HANDOFF_MESSAGE_TYPE,
        );
        return;
      }

      if (trimmed === "build" || trimmed.startsWith("build ")) {
        const buildArgs = trimmed === "build" ? "" : trimmed.slice("build".length).trimStart();
        await handleBuildDelegation(pi, ctx, buildArgs);
        return;
      }

      if (!trimmed.startsWith("/")) {
        ctx.hasUI && ctx.ui.notify("Usage: /worker status | /worker build [instructions] | /worker /<command> [args]", "error");
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
      await handleWorkerCommand(args, ctx);
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
      return { block: true, reason: `lead-worker mode is on: the lead is read-only. Use /worker build to delegate execution to ${workerSessionReference()}.` };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isSafeLeadBash(command)) {
        return { block: true, reason: `lead-worker mode is on: mutating bash is blocked for the lead. Use /worker build to delegate execution to ${workerSessionReference()}.\nCommand: ${command}` };
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
      "- Stay read-only. Do not modify files directly.",
      "- Do not use mutating bash commands.",
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
    await restoreModeState(pi, ctx).catch((err) => console.warn("[lead-worker] restoreModeState failed:", err));
    if (currentPairRole() === "worker") {
      await ensureWorkerServer(pi, ctx).catch((err) => console.warn("[lead-worker] ensureWorkerServer failed:", err));
    } else {
      await ensureLeadConnection(pi, ctx, { autoStart: false, failIfUnavailable: false }).catch(() => undefined);
    }
  };

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", async (event) => {
    rt.lastObservedLeadModel = { provider: event.model.provider, modelId: event.model.id };
  });

  pi.on("turn_end", async (_event, ctx) => {
    rt.latestPairContext = ctx;
    await maybeAutoReportWorkerCompletion(pi, ctx);
  });
}
