import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Server, Socket } from "node:net";
import {
  loadLeadWorkerSettings,
  type LeadWorkerSettings,
  type LeadWorkerSettingsLoadResult,
  type LeadWorkerSource,
} from "./settings.js";
import type { LeadSessionBinding, PendingClarificationSnapshot, WorkerStatus } from "./utils.js";
import type { PairMessageV2, PairRole } from "./protocol.js";

export const STATUS_KEY = "lead-worker";
export const TOOL_NAME = "lead_worker";
export const STATE_ENTRY_TYPE = "lead-worker-state";
export const CONTEXT_MESSAGE_TYPE = "lead-worker-context";
export const BUILD_HANDOFF_MESSAGE_TYPE = "lead-worker";
export const PAIR_MESSAGE_TYPE = "lead-worker";
export const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
export const MAX_HANDOFF_CHARS = 32_000;
export const WORKER_RELAY_DEDUP_WINDOW_MS = 60_000;
export const MAX_TRACKED_REPORTED_HANDOFF_IDS = 256;
export const MAX_SUPERVISED_STEERS = 5;
export const SUPERVISOR_MODEL_PROVIDER = "anthropic";
export const SUPERVISOR_MODEL_ID = "claude-haiku-4-5";
export const MAX_SUPERVISED_RECENT_EVENTS = 10;
export const MAX_PENDING_SUPERVISION_EVENTS = 8;
export const SOCKET_WAIT_TIMEOUT_MS = 10_000;
export const SOCKET_WAIT_INTERVAL_MS = 100;

export type LeadWorkerControlAction = "start" | "on" | "status" | "off" | "stop";
export type CommunicationAction = "message" | "ask" | "command" | "reply";
export type LeadWorkerAction = LeadWorkerControlAction | CommunicationAction;

export type LeadSelection = {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

export type PersistedLeadWorkerState = {
  enabled: boolean;
  previousActiveTools?: string[];
  previousLeadSelection?: LeadSelection;
  updatedAt: string;
};

export type ExtractedMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type LeadWorkerStatus = {
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

export type PendingRpc = {
  resolve: (message: PairMessageV2) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PendingInboundRequest = {
  from: PairRole;
  name?: string;
  body?: string;
  handoffId?: string;
  receivedAtMs: number;
};

export type ActiveConnection = {
  socket: Socket;
  pairId: string;
  socketPath: string;
  projectRoot: string;
  leadSessionId: string;
};

export type PendingWorkerHandoff = {
  id: string;
  receivedAtMs: number;
  pairId: string;
  artifactPath?: string;
  artifactSha256?: string;
  terminalEventSentAtMs?: number;
};

export type PendingClarification = PendingClarificationSnapshot & {
  replyTo?: string;
  canReplyNow: boolean;
};

export type SupervisorDecision = {
  action: "continue" | "steer" | "done" | "escalate";
  message?: string;
  confidence: number;
  reasoning: string;
};

export type ActiveSupervisedHandoff = {
  id: string;
  spec: string;
  outcome: string;
  artifactPath?: string;
  artifactSha256?: string;
  steerCount: number;
  recentEvents: PairMessageV2[];
  pendingEvents: PairMessageV2[];
  supervisionRunning: boolean;
};

export interface LeadWorkerRuntime {
  modeEnabled: boolean;
  previousActiveTools: string[] | undefined;
  previousLeadSelection: LeadSelection | undefined;
  lastObservedLeadModel: { provider?: string; modelId?: string };
  currentSettings: LeadWorkerSettingsLoadResult | undefined;
  latestPairContext: ExtensionContext | undefined;
  pendingWorkerHandoff: PendingWorkerHandoff | undefined;
  pendingClarification: PendingClarification | undefined;
  lastWorkerRelayFingerprint: string | undefined;
  lastWorkerRelayAtMs: number | undefined;
  reportedWorkerEventKeys: Set<string>;
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
  activeSupervisedHandoff: ActiveSupervisedHandoff | undefined;
}

export const rt: LeadWorkerRuntime = {
  modeEnabled: false,
  previousActiveTools: undefined,
  previousLeadSelection: undefined,
  lastObservedLeadModel: {},
  currentSettings: undefined,
  latestPairContext: undefined,
  pendingWorkerHandoff: undefined,
  pendingClarification: undefined,
  lastWorkerRelayFingerprint: undefined,
  lastWorkerRelayAtMs: undefined,
  reportedWorkerEventKeys: new Set<string>(),
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
  activeSupervisedHandoff: undefined,
};

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && "type" in block && "text" in block && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function getMessagesSinceLastUser(ctx: ExtensionContext): ExtractedMessage[] {
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

export function requireCurrentSettings(): LeadWorkerSettingsLoadResult {
  if (!rt.currentSettings) {
    throw new Error("lead-worker settings are not loaded");
  }
  return rt.currentSettings;
}

export function leadConfig(): LeadWorkerSettings["lead"] {
  return requireCurrentSettings().settings.lead;
}

export function getConfiguredLeadSelection(settings: LeadWorkerSettings = requireCurrentSettings().settings): LeadSelection | undefined {
  const ref = settings.lead.model.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator >= ref.length - 1) return undefined;
  return {
    provider: ref.slice(0, separator),
    modelId: ref.slice(separator + 1),
    thinkingLevel: settings.lead.thinking,
  };
}

export async function refreshSettings(cwd: string): Promise<LeadWorkerSettingsLoadResult> {
  rt.currentSettings = await loadLeadWorkerSettings(cwd, import.meta.url);
  return rt.currentSettings;
}

export function currentPairRole(): PairRole {
  return process.env.PI_LEAD_WORKER_ROLE === "worker" ? "worker" : "lead";
}

export function pairedRole(role: PairRole): PairRole {
  return role === "lead" ? "worker" : "lead";
}

export function getLeadSessionBinding(ctx: ExtensionContext): LeadSessionBinding {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
  };
}

export function getContextCwd(ctx: ExtensionContext): string {
  return ctx.cwd ?? process.cwd();
}

export function isTerminalSupervisionEvent(eventName: string): boolean {
  return ["completed", "failed", "cancelled"].includes(eventName);
}
