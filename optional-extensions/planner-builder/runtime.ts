import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Server, Socket } from "node:net";
import {
  loadPlannerBuilderSettings,
  type PlannerBuilderSettings,
  type PlannerBuilderSettingsLoadResult,
  type PlannerBuilderSource,
} from "./settings.js";
import type { PlannerSessionBinding, PendingClarificationSnapshot, BuilderStatus } from "./utils.js";
import type { PairMessageV2, PairRole } from "./protocol.js";

export const STATUS_KEY = "planner-builder";
export const TOOL_NAME = "planner_builder";
export const STATE_ENTRY_TYPE = "planner-builder-state";
export const CONTEXT_MESSAGE_TYPE = "planner-builder-context";
export const BUILD_HANDOFF_MESSAGE_TYPE = "planner-builder";
export const PAIR_MESSAGE_TYPE = "planner-builder";
export const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
export const MAX_HANDOFF_CHARS = 32_000;
export const BUILDER_RELAY_DEDUP_WINDOW_MS = 60_000;
export const MAX_TRACKED_REPORTED_HANDOFF_IDS = 256;
export const MAX_SUPERVISED_STEERS = 5;
export const SUPERVISOR_MODEL_PROVIDER = "anthropic";
export const SUPERVISOR_MODEL_ID = "claude-haiku-4-5";
export const MAX_SUPERVISED_RECENT_EVENTS = 10;
export const MAX_PENDING_SUPERVISION_EVENTS = 8;
export const SOCKET_WAIT_TIMEOUT_MS = 10_000;
export const SOCKET_WAIT_INTERVAL_MS = 100;

export type PlannerBuilderControlAction = "start" | "on" | "status" | "off" | "stop";
export type CommunicationAction = "message" | "ask" | "command" | "reply";
export type PlannerBuilderAction = PlannerBuilderControlAction | CommunicationAction;

export type PlannerSelection = {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

export type PersistedPlannerBuilderState = {
  enabled: boolean;
  previousActiveTools?: string[];
  previousPlannerSelection?: PlannerSelection;
  updatedAt: string;
};

export type ExtractedMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type PlannerBuilderStatus = {
  ok: true;
  action: PlannerBuilderControlAction;
  modeEnabled: boolean;
  plannerReadOnly: boolean;
  message: string;
  activeTools: string[];
  previousActiveTools?: string[];
  plannerModel?: string;
  plannerThinkingLevel: ThinkingLevel;
  configuredPlannerModel: string;
  configuredPlannerThinkingLevel: ThinkingLevel;
  previousPlannerModel?: string;
  previousPlannerThinkingLevel?: ThinkingLevel;
  settingsSources: PlannerBuilderSource[];
  settingsWarnings: string[];
  settingsInvalidFieldCount: number;
  builder: BuilderStatus;
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
  plannerSessionId: string;
};

export type PendingBuilderHandoff = {
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

export interface PlannerBuilderRuntime {
  modeEnabled: boolean;
  previousActiveTools: string[] | undefined;
  previousPlannerSelection: PlannerSelection | undefined;
  lastObservedPlannerModel: { provider?: string; modelId?: string };
  currentSettings: PlannerBuilderSettingsLoadResult | undefined;
  latestPairContext: ExtensionContext | undefined;
  pendingBuilderHandoff: PendingBuilderHandoff | undefined;
  pendingClarification: PendingClarification | undefined;
  lastBuilderRelayFingerprint: string | undefined;
  lastBuilderRelayAtMs: number | undefined;
  reportedBuilderEventKeys: Set<string>;
  pendingRpc: Map<string, PendingRpc>;
  expiredRpcIds: Set<string>;
  pendingInboundRequests: Map<string, PendingInboundRequest>;
  activeConnection: ActiveConnection | undefined;
  connectPromise: Promise<ActiveConnection> | undefined;
  connectionError: string | undefined;
  builderServer: Server | undefined;
  builderServerSocketPath: string | undefined;
  builderServerPairId: string | undefined;
  activePlannerSocket: Socket | undefined;
  activePlannerSessionId: string | undefined;
  activeSupervisedHandoff: ActiveSupervisedHandoff | undefined;
}

export const rt: PlannerBuilderRuntime = {
  modeEnabled: false,
  previousActiveTools: undefined,
  previousPlannerSelection: undefined,
  lastObservedPlannerModel: {},
  currentSettings: undefined,
  latestPairContext: undefined,
  pendingBuilderHandoff: undefined,
  pendingClarification: undefined,
  lastBuilderRelayFingerprint: undefined,
  lastBuilderRelayAtMs: undefined,
  reportedBuilderEventKeys: new Set<string>(),
  pendingRpc: new Map<string, PendingRpc>(),
  expiredRpcIds: new Set<string>(),
  pendingInboundRequests: new Map<string, PendingInboundRequest>(),
  activeConnection: undefined,
  connectPromise: undefined,
  connectionError: undefined,
  builderServer: undefined,
  builderServerSocketPath: undefined,
  builderServerPairId: undefined,
  activePlannerSocket: undefined,
  activePlannerSessionId: undefined,
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

export function requireCurrentSettings(): PlannerBuilderSettingsLoadResult {
  if (!rt.currentSettings) {
    throw new Error("planner-builder settings are not loaded");
  }
  return rt.currentSettings;
}

export function plannerConfig(): PlannerBuilderSettings["planner"] {
  return requireCurrentSettings().settings.planner;
}

export function getConfiguredPlannerSelection(settings: PlannerBuilderSettings = requireCurrentSettings().settings): PlannerSelection | undefined {
  const ref = settings.planner.model.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator >= ref.length - 1) return undefined;
  return {
    provider: ref.slice(0, separator),
    modelId: ref.slice(separator + 1),
    thinkingLevel: settings.planner.thinking,
  };
}

export async function refreshSettings(cwd: string): Promise<PlannerBuilderSettingsLoadResult> {
  rt.currentSettings = await loadPlannerBuilderSettings(cwd, import.meta.url);
  return rt.currentSettings;
}

export function currentPairRole(): PairRole {
  return process.env.PI_PLANNER_BUILDER_ROLE === "builder" ? "builder" : "planner";
}

export function pairedRole(role: PairRole): PairRole {
  return role === "planner" ? "builder" : "planner";
}

export function getPlannerSessionBinding(ctx: ExtensionContext): PlannerSessionBinding {
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
