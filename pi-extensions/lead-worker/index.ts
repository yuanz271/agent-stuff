import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  loadPlanBuildSettings,
  type PlanBuildSettings,
  type PlanBuildSettingsLoadResult,
  type PlanBuildSource,
} from "./settings.js";
import { getBuilderStatus, resolvePairChannelPaths, startBuilder, stopBuilder } from "./utils.js";
import type { BuilderStatus, PlannerSessionBinding } from "./utils.js";

const STATUS_KEY = "lead-worker";
const TOOL_NAME = "lead_worker";
const STATE_ENTRY_TYPE = "lead-worker-state";
const CONTEXT_MESSAGE_TYPE = "lead-worker-context";
const BUILD_HANDOFF_MESSAGE_TYPE = "lead-worker-handoff";
const PAIR_MESSAGE_TYPE = "lead-worker-pair-message";
const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
const MAX_HANDOFF_CHARS = 32_000;
const BUILDER_RELAY_DEDUP_WINDOW_MS = 60_000;
const BUILDER_AUTO_REPORT_SUMMARY_MAX_CHARS = 3_000;
const MAX_TRACKED_REPORTED_HANDOFF_IDS = 256;
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

type PlanBuildControlAction = "start" | "on" | "status" | "off" | "stop";

type PlannerSelection = {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

type PersistedPlanBuildState = {
  enabled: boolean;
  previousActiveTools?: string[];
  previousPlannerSelection?: PlannerSelection;
  updatedAt: string;
};

type ExtractedMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type PairRole = "planner" | "builder";

type PairChannelMessage = {
  id: string;
  from: PairRole;
  to: PairRole;
  plannerSessionId: string;
  timestamp: string;
  kind: "handoff" | "message";
  text: string;
  handoffId?: string;
};

type PlanBuildStatus = {
  ok: true;
  action: PlanBuildControlAction;
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
  settingsSources: PlanBuildSource[];
  settingsWarnings: string[];
  settingsInvalidFieldCount: number;
  worker: BuilderStatus;
};

interface PlanBuildRuntime {
  modeEnabled: boolean;
  previousActiveTools: string[] | undefined;
  previousPlannerSelection: PlannerSelection | undefined;
  lastObservedPlannerModel: { provider?: string; modelId?: string };
  currentSettings: PlanBuildSettingsLoadResult | undefined;
  pairInboxWatcher: FSWatcher | null;
  pairInboxPath: string | undefined;
  pairInboxDebounceTimer: ReturnType<typeof setTimeout> | null;
  pairInboxPollTimer: ReturnType<typeof setInterval> | null;
  pairMessageProcessing: boolean;
  pairMessageNeedsRecheck: boolean;
  latestPairContext: ExtensionContext | undefined;
  pendingBuilderHandoff:
    | { id: string; receivedAtMs: number; plannerSessionId: string }
    | undefined;
  lastOutboundPairMessageAtMs: number | undefined;
  lastBuilderRelayFingerprint: string | undefined;
  lastBuilderRelayAtMs: number | undefined;
  reportedBuilderHandoffIds: Set<string>;
}

const rt: PlanBuildRuntime = {
  modeEnabled: false,
  previousActiveTools: undefined,
  previousPlannerSelection: undefined,
  lastObservedPlannerModel: {},
  currentSettings: undefined,
  pairInboxWatcher: null,
  pairInboxPath: undefined,
  pairInboxDebounceTimer: null,
  pairInboxPollTimer: null,
  pairMessageProcessing: false,
  pairMessageNeedsRecheck: false,
  latestPairContext: undefined,
  pendingBuilderHandoff: undefined,
  lastOutboundPairMessageAtMs: undefined,
  lastBuilderRelayFingerprint: undefined,
  lastBuilderRelayAtMs: undefined,
  reportedBuilderHandoffIds: new Set<string>(),
};

function normalizeControlAction(raw: string): PlanBuildControlAction | null {
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
    // Allow redirecting stdout/stderr to /dev/null (non-mutating sink)
    .replace(/(^|[\s;|&])(?:[12]?>\s*\/dev\/null)(?=$|[\s;|&])/gi, "$1")
    // Allow fd merging (e.g., 2>&1, 1>&2)
    .replace(/(^|[\s;|&])(?:[12]?>&[12])(?=$|[\s;|&])/g, "$1");
}

function isSafePlannerBash(command: string): boolean {
  const commandForMutatingChecks = stripBenignRedirects(command);
  const destructive = MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(commandForMutatingChecks));
  const safe = SAFE_BASH_PREFIXES.some((pattern) => pattern.test(command));
  return safe && !destructive;
}

function requireCurrentSettings(): PlanBuildSettingsLoadResult {
  if (!rt.currentSettings) {
    throw new Error("lead-worker settings are not loaded");
  }
  return rt.currentSettings;
}

function builderSessionReference(): string {
  return "the paired worker session";
}

function leadConfig(): PlanBuildSettings["lead"] {
  return requireCurrentSettings().settings.lead;
}

function getConfiguredPlannerSelection(settings: PlanBuildSettings = requireCurrentSettings().settings): PlannerSelection | undefined {
  const ref = settings.lead.model.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator >= ref.length - 1) return undefined;
  return {
    provider: ref.slice(0, separator),
    modelId: ref.slice(separator + 1),
    thinkingLevel: settings.lead.thinking,
  };
}

async function refreshSettings(cwd: string): Promise<PlanBuildSettingsLoadResult> {
  rt.currentSettings = await loadPlanBuildSettings(cwd, import.meta.url);
  return rt.currentSettings;
}

function currentPairRole(): PairRole {
  return process.env.PI_PLAN_MODE_ROLE === "builder" ? "builder" : "planner";
}

function pairedRole(role: PairRole): PairRole {
  return role === "planner" ? "builder" : "planner";
}

function getPlannerSessionBinding(ctx: ExtensionContext): PlannerSessionBinding {
  const builderPlannerSessionId = process.env.PI_PLAN_BUILD_PLANNER_SESSION_ID?.trim();
  if (currentPairRole() === "builder" && builderPlannerSessionId) {
    return { sessionId: builderPlannerSessionId };
  }
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
  };
}

function validToolNames(pi: ExtensionAPI): Set<string> {
  return new Set(pi.getAllTools().map((tool) => tool.name));
}

function filterPlannerTools(pi: ExtensionAPI, sourceTools: string[]): string[] {
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

function normalizePlannerSelection(selection: PlannerSelection | undefined): PlannerSelection | undefined {
  if (!selection) return undefined;
  const provider = typeof selection.provider === "string" && selection.provider.trim() ? selection.provider.trim() : undefined;
  const modelId = typeof selection.modelId === "string" && selection.modelId.trim() ? selection.modelId.trim() : undefined;
  const thinkingLevel = selection.thinkingLevel;
  if (!provider && !modelId && !thinkingLevel) return undefined;
  return { provider, modelId, thinkingLevel };
}

function formatPlannerModel(selection: PlannerSelection | undefined): string | undefined {
  if (!selection?.provider || !selection.modelId) return undefined;
  return `${selection.provider}/${selection.modelId}`;
}

function getCurrentPlannerSelection(pi: ExtensionAPI, ctx: ExtensionContext): PlannerSelection {
  return {
    provider: rt.lastObservedPlannerModel.provider ?? ctx.model?.provider,
    modelId: rt.lastObservedPlannerModel.modelId ?? ctx.model?.id,
    thinkingLevel: pi.getThinkingLevel(),
  };
}

async function applyPlannerSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection: PlannerSelection | undefined,
): Promise<string | undefined> {
  const normalized = normalizePlannerSelection(selection);
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
        rt.lastObservedPlannerModel = { provider: normalized.provider, modelId: normalized.modelId };
      }
    }
  }

  if (normalized.thinkingLevel) {
    pi.setThinkingLevel(normalized.thinkingLevel);
  }

  return warning;
}

function persistModeState(pi: ExtensionAPI): void {
  pi.appendEntry<PersistedPlanBuildState>(STATE_ENTRY_TYPE, {
    enabled: rt.modeEnabled,
    previousActiveTools: rt.previousActiveTools,
    previousPlannerSelection: rt.previousPlannerSelection,
    updatedAt: new Date().toISOString(),
  });
}

function restorePersistedState(ctx: ExtensionContext): PersistedPlanBuildState | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as PersistedPlanBuildState | undefined;
    if (!data || typeof data.enabled !== "boolean") continue;
    return {
      enabled: data.enabled,
      previousActiveTools: Array.isArray(data.previousActiveTools) ? data.previousActiveTools.filter((name) => typeof name === "string") : undefined,
      previousPlannerSelection: normalizePlannerSelection(data.previousPlannerSelection),
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

function applyPlannerMode(pi: ExtensionAPI): void {
  if (!rt.modeEnabled) return;
  if (!rt.previousActiveTools || rt.previousActiveTools.length === 0) {
    rt.previousActiveTools = pi.getActiveTools();
  }
  pi.setActiveTools(filterPlannerTools(pi, rt.previousActiveTools));
}

async function restoreModeState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await refreshSettings(ctx.cwd ?? process.cwd());

  const restored = restorePersistedState(ctx);
  rt.modeEnabled = restored?.enabled ?? false;
  rt.previousActiveTools = rt.modeEnabled ? restored?.previousActiveTools ?? pi.getActiveTools() : undefined;
  rt.previousPlannerSelection = rt.modeEnabled ? restored?.previousPlannerSelection : undefined;

  if (rt.modeEnabled) {
    applyPlannerMode(pi);
    const warning = await applyPlannerSelection(pi, ctx, getConfiguredPlannerSelection());
    if (warning && ctx.hasUI) {
      ctx.ui.notify(`lead-worker: ${warning}`, "warning");
    }
  }

  const worker = await getBuilderStatus(
    pi,
    ctx.cwd ?? process.cwd(),
    requireCurrentSettings().settings,
    getPlannerSessionBinding(ctx),
  ).catch(() => undefined);
  if (worker) updateStatusLine(ctx, worker);
}

function renderSummary(worker: BuilderStatus): string | undefined {
  if (!rt.modeEnabled && !worker.running) return undefined;
  const builderPart = worker.running ? `${worker.agentName}:on (${worker.tmuxSession})` : `${worker.agentName}:off`;
  if (!rt.modeEnabled) return builderPart;
  return `lead:on | ${builderPart}`;
}

function updateStatusLine(ctx: ExtensionContext, worker: BuilderStatus): void {
  if (!ctx.hasUI) return;
  const summary = renderSummary(worker);
  if (!summary) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  if (rt.modeEnabled) {
    const plannerPart = theme.fg("warning", "lead:on");
    const builderPart = worker.running
      ? theme.fg("accent", `${worker.agentName}:on (${worker.tmuxSession})`)
      : theme.fg("muted", `${worker.agentName}:off`);
    ctx.ui.setStatus(STATUS_KEY, `${plannerPart} | ${builderPart}`);
    return;
  }

  const builderPart = worker.running
    ? theme.fg("accent", `${worker.agentName}:on (${worker.tmuxSession})`)
    : theme.fg("muted", `${worker.agentName}:off`);
  ctx.ui.setStatus(STATUS_KEY, builderPart);
}

function buildStatus(action: PlanBuildControlAction, message: string, worker: BuilderStatus, pi: ExtensionAPI): PlanBuildStatus {
  const plannerModel = formatPlannerModel({
    provider: rt.lastObservedPlannerModel.provider,
    modelId: rt.lastObservedPlannerModel.modelId,
  });
  const previousPlannerModel = formatPlannerModel(rt.previousPlannerSelection);
  const loadedSettings = requireCurrentSettings();

  return {
    ok: true,
    action,
    modeEnabled: rt.modeEnabled,
    plannerReadOnly: rt.modeEnabled,
    message,
    activeTools: pi.getActiveTools(),
    previousActiveTools: rt.previousActiveTools,
    plannerModel,
    plannerThinkingLevel: pi.getThinkingLevel(),
    configuredPlannerModel: loadedSettings.settings.lead.model,
    configuredPlannerThinkingLevel: loadedSettings.settings.lead.thinking,
    previousPlannerModel,
    previousPlannerThinkingLevel: rt.previousPlannerSelection?.thinkingLevel,
    settingsSources: loadedSettings.stats.loaded_sources,
    settingsWarnings: loadedSettings.warnings,
    settingsInvalidFieldCount: loadedSettings.stats.invalid_field_count,
    worker,
  };
}

function formatStatusMarkdown(status: PlanBuildStatus): string {
  const lines = [
    `**lead-worker ${status.action}**`,
    "",
    `- message: ${status.message}`,
    `- lead mode: ${status.modeEnabled ? "on" : "off"}`,
    `- lead behavior: ${status.plannerReadOnly ? "lead (read-only)" : "normal"}`,
    `- lead model: ${status.plannerModel ?? "unknown"}`,
    `- lead thinking: ${status.plannerThinkingLevel}`,
    `- configured plan model: ${status.configuredPlannerModel}`,
    `- configured plan thinking: ${status.configuredPlannerThinkingLevel}`,
    `- active tools: ${status.activeTools.length > 0 ? status.activeTools.join(", ") : "(none)"}`,
  ];

  if (status.previousPlannerModel) {
    lines.push(`- restore model on off: ${status.previousPlannerModel}`);
  }
  if (status.previousPlannerThinkingLevel) {
    lines.push(`- restore thinking on off: ${status.previousPlannerThinkingLevel}`);
  }

  lines.push(
    "",
    "**settings**",
    "",
    `- loaded sources: ${status.settingsSources.map((source) => `${source.kind}:${source.path}`).join(", ")}`,
    `- invalid fields ignored: ${status.settingsInvalidFieldCount}`,
    "",
    "**builder**",
    "",
    `- running: ${status.worker.running ? "yes" : "no"}`,
    `- name: ${status.worker.agentName}`,
    `- model: ${status.worker.model}`,
    `- thinking: ${status.worker.thinking}`,
    `- lead session id: ${status.worker.plannerSessionId}`,
    `- tmux session: ${status.worker.tmuxSession}`,
    `- session file: ${status.worker.sessionFile}`,
    `- log file: ${status.worker.logFile}`,
    `- launch script: ${status.worker.launchScript}`,
  );

  if (status.worker.plannerSessionFile) lines.push(`- lead session file: ${status.worker.plannerSessionFile}`);
  if (status.worker.startedAt) lines.push(`- started: ${status.worker.startedAt}`);
  if (status.worker.lastStoppedAt) lines.push(`- last stopped: ${status.worker.lastStoppedAt}`);
  if (status.worker.alreadyRunning) lines.push(`- note: existing ${status.worker.agentName} session reused`);

  if (status.settingsWarnings.length > 0 || status.worker.warnings.length > 0) {
    lines.push("", "**warnings**", "");
    for (const warning of status.settingsWarnings) {
      lines.push(`- settings: ${warning}`);
    }
    for (const warning of status.worker.warnings) {
      lines.push(`- ${warning}`);
    }
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

async function startOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const worker = await startBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  updateStatusLine(ctx, worker);
  return buildStatus("start", worker.message, worker, pi);
}

async function enableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const capturedTools = rt.modeEnabled ? rt.previousActiveTools : pi.getActiveTools();
  const capturedSelection = rt.modeEnabled ? rt.previousPlannerSelection : getCurrentPlannerSelection(pi, ctx);
  const worker = await startBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  const configuredSelection = getConfiguredPlannerSelection(settings);

  rt.modeEnabled = true;
  rt.previousActiveTools = normalizeToolList(pi, capturedTools);
  if (rt.previousActiveTools.length === 0) {
    rt.previousActiveTools = pi.getActiveTools();
  }
  rt.previousPlannerSelection = normalizePlannerSelection(capturedSelection);

  const switchWarning = await applyPlannerSelection(pi, ctx, configuredSelection);

  applyPlannerMode(pi);
  persistModeState(pi);
  updateStatusLine(ctx, worker);

  const configuredModelLabel = formatPlannerModel(configuredSelection) ?? settings.lead.model;
  const switchMessage = switchWarning
    ? `Planner remained on ${formatPlannerModel(getCurrentPlannerSelection(pi, ctx)) ?? "the current model"} (${switchWarning})`
    : `Planner switched to ${configuredModelLabel} (${settings.lead.thinking})`;

  return buildStatus(
    "on",
    `Lead-worker mode enabled. Planner is now read-only. ${switchMessage}. ${worker.message}`,
    worker,
    pi,
  );
}

async function restorePlannerMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  worker: BuilderStatus,
): Promise<string> {
  const toolsToRestore = rt.previousActiveTools;
  const plannerToRestore = rt.previousPlannerSelection;

  rt.modeEnabled = false;
  restoreNormalTools(pi, toolsToRestore);

  const restoreWarning = await applyPlannerSelection(pi, ctx, plannerToRestore);

  rt.previousActiveTools = undefined;
  rt.previousPlannerSelection = undefined;
  persistModeState(pi);
  updateStatusLine(ctx, worker);

  const restoreTarget = formatPlannerModel(plannerToRestore);
  return restoreWarning
    ? `Planner model restore was skipped (${restoreWarning})`
    : restoreTarget
      ? `Planner restored to ${restoreTarget}${plannerToRestore?.thinkingLevel ? ` (${plannerToRestore.thinkingLevel})` : ""}`
      : "Planner returned to its prior model state";
}

async function disableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const worker = await getBuilderStatus(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  const restoreMessage = await restorePlannerMode(pi, ctx, worker);

  return buildStatus(
    "off",
    `Lead-worker mode disabled. Planner returned to normal mode. ${restoreMessage}. ${worker.running ? `Builder ${worker.agentName} is still running.` : `Builder ${worker.agentName} is not running.`}`,
    worker,
    pi,
  );
}

async function statusOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const worker = await getBuilderStatus(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  updateStatusLine(ctx, worker);
  return buildStatus(
    "status",
    `Lead-worker mode is ${rt.modeEnabled ? "on" : "off"}. Planner model is ${formatPlannerModel(getCurrentPlannerSelection(pi, ctx)) ?? "unknown"}. Builder ${worker.agentName} is ${worker.running ? "running" : "not running"}.`,
    worker,
    pi,
  );
}

async function stopOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const worker = await stopBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));

  if (rt.modeEnabled) {
    const restoreMessage = await restorePlannerMode(pi, ctx, worker);
    return buildStatus(
      "stop",
      `Builder ${worker.agentName} forcibly terminated. Lead-worker mode disabled. ${restoreMessage}.`,
      worker,
      pi,
    );
  }

  updateStatusLine(ctx, worker);
  return buildStatus("stop", `Builder ${worker.agentName} forcibly terminated.`, worker, pi);
}

async function runControlAction(pi: ExtensionAPI, ctx: ExtensionContext, action: PlanBuildControlAction): Promise<PlanBuildStatus> {
  const { settings } = await refreshSettings(ctx.cwd ?? process.cwd());

  switch (action) {
    case "start":
      return startOnly(pi, ctx, settings);
    case "on":
      return enableMode(pi, ctx, settings);
    case "status":
      return statusOnly(pi, ctx, settings);
    case "off":
      return disableMode(pi, ctx, settings);
    case "stop":
      return stopOnly(pi, ctx, settings);
  }
}

async function resolveCommandAction(raw: string): Promise<PlanBuildControlAction | null> {
  const explicit = normalizeControlAction(raw);
  if (explicit) return explicit;
  if (raw.trim() !== "") return null;
  return rt.modeEnabled ? "off" : "on";
}

async function resolvePairMessageContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<{
  role: PairRole;
  plannerSession: PlannerSessionBinding;
  inboxPath: string;
  targetInboxPath: string;
}> {
  const role = currentPairRole();
  const plannerSession = getPlannerSessionBinding(ctx);
  const paths = await resolvePairChannelPaths(pi, ctx.cwd ?? process.cwd(), plannerSession);
  return {
    role,
    plannerSession,
    inboxPath: role === "planner" ? paths.plannerInbox : paths.builderInbox,
    targetInboxPath: role === "planner" ? paths.builderInbox : paths.plannerInbox,
  };
}

function isPairChannelMessage(value: unknown): value is PairChannelMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === "string" &&
    (message.from === "planner" || message.from === "builder") &&
    (message.to === "planner" || message.to === "builder") &&
    typeof message.plannerSessionId === "string" &&
    typeof message.timestamp === "string" &&
    (message.kind === "handoff" || message.kind === "message") &&
    typeof message.text === "string" &&
    (message.handoffId === undefined || typeof message.handoffId === "string")
  );
}

function extractHandoffIdFromText(text: string): string | undefined {
  const direct = text.match(/\bhandoff[_\s-]?id\s*:\s*([a-zA-Z0-9_-]+)/i);
  if (direct?.[1]) return direct[1];
  const bracketed = text.match(/\[handoff[_\s-]?id\s*=\s*([a-zA-Z0-9_-]+)\]/i);
  if (bracketed?.[1]) return bracketed[1];
  return undefined;
}

function getMessageHandoffId(message: PairChannelMessage): string | undefined {
  return message.handoffId ?? extractHandoffIdFromText(message.text);
}

function formatIncomingPairMessage(message: PairChannelMessage): string {
  const heading = message.kind === "handoff"
    ? `**lead-worker handoff from ${message.from}**`
    : `**lead-worker message from ${message.from}**`;
  const handoffId = getMessageHandoffId(message);
  return [
    heading,
    "",
    `- lead session id: ${message.plannerSessionId}`,
    ...(handoffId ? [`- handoff id: ${handoffId}`] : []),
    "",
    message.text,
  ].join("\n");
}

function normalizeWhitespaceLower(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function pairRelayFingerprint(message: PairChannelMessage): string {
  const handoffId = getMessageHandoffId(message) ?? "";
  return `${message.from}|${message.to}|${message.kind}|${message.plannerSessionId}|${handoffId}|${normalizeWhitespaceLower(message.text)}`;
}

function isBuilderCompletionMessage(message: PairChannelMessage): boolean {
  if (message.from !== "builder" || message.kind !== "message") return false;

  const normalized = normalizeWhitespaceLower(message.text);
  if (normalized.startsWith("worker completion report")) return true;

  const hasStatus = /\bstatus\s*:\s*(done|blocked)\b/i.test(message.text);
  const hasFiles = /\bfiles\s+changed\s*:/i.test(message.text);
  const hasValidation = /\bvalidation\s*:/i.test(message.text);
  return hasStatus && hasFiles && hasValidation;
}

function rememberReportedBuilderHandoff(handoffId: string): void {
  rt.reportedBuilderHandoffIds.add(handoffId);
  if (rt.reportedBuilderHandoffIds.size <= MAX_TRACKED_REPORTED_HANDOFF_IDS) return;

  const oldest = rt.reportedBuilderHandoffIds.values().next().value;
  if (oldest) rt.reportedBuilderHandoffIds.delete(oldest);
}

function maybeRelayBuilderMessageToUser(pi: ExtensionAPI, message: PairChannelMessage): void {
  if (currentPairRole() !== "planner") return;
  if (!isBuilderCompletionMessage(message)) return;

  const handoffId = getMessageHandoffId(message);
  if (handoffId && rt.reportedBuilderHandoffIds.has(handoffId)) return;

  const now = Date.now();
  const fingerprint = pairRelayFingerprint(message);
  const withinWindow = (rt.lastBuilderRelayAtMs ?? 0) > now - BUILDER_RELAY_DEDUP_WINDOW_MS;
  if (withinWindow && rt.lastBuilderRelayFingerprint === fingerprint) return;

  rt.lastBuilderRelayFingerprint = fingerprint;
  rt.lastBuilderRelayAtMs = now;
  if (handoffId) rememberReportedBuilderHandoff(handoffId);

  const relayPrompt = [
    "Builder sent a completion update.",
    "Reply to the USER now with a concise status update.",
    "Include: (1) done/blocked, (2) files changed, (3) validation result, (4) next step.",
    "Do not ask the worker to repeat the same report unless critical information is missing.",
    ...(handoffId ? ["", `handoff_id: ${handoffId}`] : []),
    "",
    `Builder message (${message.kind}):`,
    message.text,
  ].join("\n");

  pi.sendUserMessage(relayPrompt, { deliverAs: "followUp" });
}

function deliverPairMessage(pi: ExtensionAPI, message: PairChannelMessage): void {
  pi.sendMessage(
    {
      customType: PAIR_MESSAGE_TYPE,
      content: formatIncomingPairMessage(message),
      display: true,
      details: message,
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
  maybeRelayBuilderMessageToUser(pi, message);
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

async function maybeAutoReportBuilderCompletion(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (currentPairRole() !== "builder") return;
  const pending = rt.pendingBuilderHandoff;
  if (!pending) return;

  // Builder already sent a manual paired message for this handoff.
  if ((rt.lastOutboundPairMessageAtMs ?? 0) >= pending.receivedAtMs) {
    rt.pendingBuilderHandoff = undefined;
    return;
  }

  const summary = latestAssistantText(ctx);
  if (!summary) return;

  const report = [
    "Builder completion report (auto):",
    `- handoff_id: ${pending.id}`,
    "- status: done",
    "- files changed: see latest worker response and diffs",
    "- validation: see latest worker response",
    "- details:",
    truncate(summary, BUILDER_AUTO_REPORT_SUMMARY_MAX_CHARS),
  ].join("\n");

  await queuePairedMessage(pi, ctx, report, "message", { handoffId: pending.id });
  rt.pendingBuilderHandoff = undefined;
}

async function processPendingPairMessages(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  rt.latestPairContext = ctx;
  if (rt.pairMessageProcessing) {
    rt.pairMessageNeedsRecheck = true;
    return;
  }

  rt.pairMessageProcessing = true;
  try {
    const { inboxPath, plannerSession, role } = await resolvePairMessageContext(pi, ctx);
    await fs.mkdir(inboxPath, { recursive: true });
    const files = (await fs.readdir(inboxPath)).filter((file) => file.endsWith(".json")).sort();

    for (const file of files) {
      const messagePath = join(inboxPath, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(messagePath, "utf8"));
      } catch {
        // Malformed or unreadable — discard after one read attempt.
        await fs.unlink(messagePath).catch(() => {});
        continue;
      }
      if (!isPairChannelMessage(parsed)) {
        await fs.unlink(messagePath).catch(() => {});
        continue;
      }
      if (parsed.to !== role || parsed.plannerSessionId !== plannerSession.sessionId) {
        await fs.unlink(messagePath).catch(() => {});
        continue;
      }
      // Delivery errors propagate so a valid message is never silently lost.
      deliverPairMessage(pi, parsed);
      if (role === "builder" && parsed.kind === "handoff") {
        rt.pendingBuilderHandoff = {
          id: getMessageHandoffId(parsed) ?? parsed.id,
          receivedAtMs: Date.parse(parsed.timestamp) || Date.now(),
          plannerSessionId: parsed.plannerSessionId,
        };
      }
      await fs.unlink(messagePath).catch(() => {});
    }
  } finally {
    rt.pairMessageProcessing = false;
    if (rt.pairMessageNeedsRecheck && rt.latestPairContext) {
      rt.pairMessageNeedsRecheck = false;
      void processPendingPairMessages(pi, rt.latestPairContext);
    }
  }
}

function stopPairInboxWatcher(): void {
  if (rt.pairInboxDebounceTimer) {
    clearTimeout(rt.pairInboxDebounceTimer);
    rt.pairInboxDebounceTimer = null;
  }
  if (rt.pairInboxPollTimer) {
    clearInterval(rt.pairInboxPollTimer);
    rt.pairInboxPollTimer = null;
  }
  if (rt.pairInboxWatcher) {
    rt.pairInboxWatcher.close();
    rt.pairInboxWatcher = null;
  }
  rt.pairInboxPath = undefined;
}

async function startPairInboxWatcher(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  rt.latestPairContext = ctx;
  const { inboxPath } = await resolvePairMessageContext(pi, ctx);
  await fs.mkdir(inboxPath, { recursive: true });

  if (rt.pairInboxWatcher && rt.pairInboxPath === inboxPath) {
    await processPendingPairMessages(pi, ctx);
    return;
  }

  stopPairInboxWatcher();
  rt.pairInboxPath = inboxPath;
  await processPendingPairMessages(pi, ctx);

  rt.pairInboxWatcher = watch(inboxPath, () => {
    if (rt.pairInboxDebounceTimer) {
      clearTimeout(rt.pairInboxDebounceTimer);
    }
    rt.pairInboxDebounceTimer = setTimeout(() => {
      rt.pairInboxDebounceTimer = null;
      if (rt.latestPairContext) {
        void processPendingPairMessages(pi, rt.latestPairContext);
      }
    }, 50);
  });

  rt.pairInboxWatcher.on("error", () => {
    stopPairInboxWatcher();
  });

  // Fallback polling: some environments can miss fs.watch events for directory writes.
  // Keep a lightweight periodic scan so builder→lead messages are eventually delivered.
  rt.pairInboxPollTimer = setInterval(() => {
    if (rt.latestPairContext) {
      void processPendingPairMessages(pi, rt.latestPairContext).catch((err) => {
        console.warn("[lead-worker] periodic pair inbox scan failed:", err);
      });
    }
  }, 2_000);
}

async function queuePairedMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
  kind: PairChannelMessage["kind"],
  opts?: { handoffId?: string },
): Promise<{ queuedPath: string; plannerSessionId: string; to: PairRole; handoffId?: string }> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("message text is required");
  }

  const { plannerSession, role, targetInboxPath } = await resolvePairMessageContext(pi, ctx);
  await fs.mkdir(targetInboxPath, { recursive: true });

  const message: PairChannelMessage = {
    id: randomUUID(),
    from: role,
    to: pairedRole(role),
    plannerSessionId: plannerSession.sessionId,
    timestamp: new Date().toISOString(),
    kind,
    text: trimmed,
    ...(opts?.handoffId ? { handoffId: opts.handoffId } : {}),
  };

  const queuedPath = join(targetInboxPath, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeFile(queuedPath, JSON.stringify(message, null, 2), "utf8");
  rt.lastOutboundPairMessageAtMs = Date.now();

  return {
    queuedPath,
    plannerSessionId: plannerSession.sessionId,
    to: message.to,
    handoffId: message.handoffId,
  };
}

async function sendPairMessageAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rawMessage: string | undefined,
): Promise<{ ok: true; action: "message"; role: PairRole; to: PairRole; plannerSessionId: string; queuedPath: string; handoffId?: string }> {
  const role = currentPairRole();
  const handoffId = role === "builder" ? rt.pendingBuilderHandoff?.id : undefined;
  const queued = await queuePairedMessage(pi, ctx, rawMessage ?? "", "message", { handoffId });
  return {
    ok: true,
    action: "message",
    role,
    to: queued.to,
    plannerSessionId: queued.plannerSessionId,
    queuedPath: queued.queuedPath,
    handoffId: queued.handoffId,
  };
}

function buildHandoffText(ctx: ExtensionContext, extraInstructions: string, handoffId: string): string | null {
  const recent = getMessagesSinceLastUser(ctx);
  const trimmedExtra = extraInstructions.trim();
  if (recent.length === 0 && !trimmedExtra) return null;

  const lines = [
    `Planner handoff from session ${ctx.sessionManager.getSessionId()} in ${ctx.cwd ?? process.cwd()}.`,
    `Implement the agreed plan in the worker dedicated to this lead session. The lead remains read-only.`,
    `handoff_id: ${handoffId}`,
    'Direct paired communication is available through lead_worker({ action: "message", message: "..." }).',
    "",
  ];

  if (trimmedExtra) {
    lines.push("Additional build instruction:", trimmedExtra, "");
  }

  if (recent.length > 0) {
    lines.push("Recent lead exchange:", "");
    for (const message of recent) {
      const role = message.role === "user" ? "User" : "Planner";
      lines.push(`${role}:`, message.content, "");
    }
  }

  lines.push(
    "Execution expectations:",
    "- send intent/spec only: goal, relevant files, implementation steps, constraints, and validation criteria",
    "- do not send concrete code snippets, patches, or copy-paste-ready implementation blocks to the builder",
    "- implement the requested change in the worker session",
    "- run the smallest relevant validation",
    '- send exactly one completion message to the lead for this handoff via lead_worker({ action: "message", message: "..." }) including handoff_id, status, files changed, and validation results',
    '- additional lead messages are only for material blockers or concrete clarification questions',
    "- if blocked on the task itself, report the minimal blocker and the next action needed",
  );

  const joined = lines.join("\n").trim();
  return joined.length <= MAX_HANDOFF_CHARS ? joined : joined.slice(0, MAX_HANDOFF_CHARS - 1) + "…";
}

function formatBuildQueuedMarkdown(worker: BuilderStatus, queuedPath: string, handoffId: string): string {
  const lines = [
    `**build delegated**`,
    "",
    `- lead mode: ${rt.modeEnabled ? "on" : "off"}`,
    `- lead session id: ${worker.plannerSessionId}`,
    `- worker name: ${worker.agentName}`,
    `- worker running: ${worker.running ? "yes" : "no"}`,
    `- worker session: ${worker.tmuxSession}`,
    `- handoff id: ${handoffId}`,
    `- queued pair-message file: ${queuedPath}`,
    `- paired transport: internal lead-worker mailbox`,
  ];

  return lines.join("\n");
}

async function handleBuildDelegation(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  if (!rt.modeEnabled) {
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.hasUI && ctx.ui.notify("Wait for the lead to finish its current turn before delegating with /build.", "warning");
    return;
  }

  const { settings } = await refreshSettings(ctx.cwd ?? process.cwd());
  const handoffId = randomUUID();
  const handoff = buildHandoffText(ctx, args, handoffId);
  if (!handoff) {
    ctx.hasUI && ctx.ui.notify("No recent lead context found. Ask the lead first or pass explicit instructions to /build.", "error");
    return;
  }

  const plannerSession = getPlannerSessionBinding(ctx);
  let worker = await getBuilderStatus(pi, ctx.cwd ?? process.cwd(), settings, plannerSession);
  if (!worker.running) {
    worker = await startBuilder(pi, ctx.cwd ?? process.cwd(), settings, plannerSession);
    updateStatusLine(ctx, worker);
  }

  const queued = await queuePairedMessage(pi, ctx, handoff, "handoff", { handoffId });
  emitInfo(pi, formatBuildQueuedMarkdown(worker, queued.queuedPath, handoffId), BUILD_HANDOFF_MESSAGE_TYPE);
}

type BuilderInterruptState = {
  tmuxSession: string;
  tmuxPaneId?: string;
  agentName?: string;
};

type BuilderInterruptResolution = {
  cwd: string;
  state: BuilderInterruptState;
};

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

  const cwd = ctx.cwd ?? process.cwd();
  const plannerSession = getPlannerSessionBinding(ctx);
  const paths = await resolvePairChannelPaths(pi, cwd, plannerSession);
  const statePath = join(paths.runtimeDir, "builder-state.json");

  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw new Error(`Failed to read worker state file ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isBuilderInterruptState(parsed)) {
    throw new Error(`Invalid worker state file ${statePath}: missing tmuxSession`);
  }

  const hasSession = await pi.exec("tmux", ["has-session", "-t", parsed.tmuxSession], {
    cwd,
    timeout: 5_000,
  });
  if (!tmuxExecSucceeded(hasSession)) return null;

  return { cwd, state: parsed };
}

async function interruptBuilderIfRunning(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  const resolved = await resolveBuilderInterruptState(pi, ctx);
  if (!resolved) return false;

  const { cwd, state } = resolved;
  const target = state.tmuxPaneId?.trim() || `${state.tmuxSession}:0.0`;
  const sent = await pi.exec("tmux", ["send-keys", "-t", target, "C-c"], {
    cwd,
    timeout: 5_000,
  });
  if (!tmuxExecSucceeded(sent)) {
    throw new Error(sent.stderr?.trim() || sent.stdout?.trim() || `Failed to interrupt worker pane ${target}`);
  }

  const agentName = state.agentName?.trim() || "builder";
  ctx.hasUI && ctx.ui.notify(`Sent interrupt to ${agentName} (${target}).`, "warning");
  return true;
}

export default function leadWorkerExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Lead Worker",
    description:
      "Manage lead-worker mode and the current lead session's worker configured by lead-worker-settings.yaml. " +
      "Actions: start, on, status, off, stop, message. " +
      "start spawns the current lead session's worker without changing mode; on enables read-only lead mode, switches the lead to the configured planning model, and starts the worker if needed; off restores normal lead behavior and restores the previous model/thinking while leaving the worker alone; stop forcibly terminates the current lead session's worker and, if lead-worker mode is on, also returns the lead to normal mode; message sends a direct paired lead↔worker note through lead-worker's internal mailbox.",
    parameters: Type.Object({
      action: StringEnum(["start", "on", "status", "off", "stop", "message"] as const, {
        description: "Lead-worker control action for planner/build mode or direct paired messaging",
      }),
      message: Type.Optional(Type.String({ description: "Required for action='message'. Direct message text for the paired lead or worker." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (params.action === "message") {
          const result = await sendPairMessageAction(pi, ctx, params.message);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        }
        const status = await runControlAction(pi, ctx, params.action);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          details: status,
        };
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
    let action: PlanBuildControlAction | null = null;
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

  pi.registerCommand("lead", {
    description: "Control lead-worker mode and the current lead session's worker: /lead [start|on|status|off|stop] (bare command toggles mode; on switches the lead model, off restores it, stop also exits lead-worker mode if it is on)",
    handler: async (args, ctx) =>
      handleControlCommand(args, ctx, "Usage: /lead [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("build", {
    description: "Delegate the latest lead context to the current lead session's worker. Does nothing when lead-worker mode is off.",
    handler: async (args, ctx) => {
      try {
        await handleBuildDelegation(pi, ctx, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI && ctx.ui.notify(`build delegation failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("abort", {
    description:
      "Abort the current lead turn, or when lead-worker mode is on and the worker is running, send Ctrl+C to the paired worker's active tmux pane.",
    handler: async (_args, ctx) => {
      try {
        if (await interruptBuilderIfRunning(pi, ctx)) {
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI && ctx.ui.notify(`worker interrupt failed during /abort: ${message}; aborting lead turn instead.`, "error");
      }

      // Always retain planner-side abort path, even if worker interrupt fails.
      await ctx.abort();
    },
  });

  pi.on("tool_call", async (event) => {
    if (!rt.modeEnabled) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason: `lead-worker mode is on: the lead is read-only. Use /build to delegate execution to ${builderSessionReference()}.`,
      };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isSafePlannerBash(command)) {
        return {
          block: true,
          reason: `lead-worker mode is on: mutating bash is blocked for the lead. Use /build to delegate execution to ${builderSessionReference()}.\nCommand: ${command}`,
        };
      }
    }

    if (event.toolName === TOOL_NAME) {
      const action = typeof event.input.action === "string" ? event.input.action : "";
      if (action !== "message") {
        return {
          block: true,
          reason: `lead-worker mode is on: worker lifecycle control should go through explicit slash commands (/lead, /build). The only allowed lead tool call is lead_worker({ action: "message", ... }) for concise paired messages.`,
        };
      }
    }
  });

  pi.on("context", async (event) => {
    if (rt.modeEnabled) return;
    return {
      messages: event.messages.filter((message) => {
        if (message.role !== "custom") return true;
        return message.customType !== CONTEXT_MESSAGE_TYPE;
      }),
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
      "- When the user wants execution, they will run /build to delegate the current plan to the worker dedicated to this lead session.",
      '- You may send concise direct messages to the paired worker with lead_worker({ action: "message", message: "..." }). Use this for clarifications or course corrections, not chatter.',
      "- The paired worker may also message you directly. Answer only when it materially helps execution.",
      "- Prefer concise worker handoff packets with: goal, relevant files, implementation steps, and validation.",
    ];

    const plannerPromptAppend = leadConfig().prompt_append;
    if (plannerPromptAppend) {
      lines.push("", plannerPromptAppend);
    }

    return {
      message: {
        customType: CONTEXT_MESSAGE_TYPE,
        content: lines.join("\n"),
        display: false,
      },
    };
  });

  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    rt.lastObservedPlannerModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
    await restoreModeState(pi, ctx).catch((err) => {
      console.warn("[lead-worker] restoreModeState failed:", err);
    });
    await startPairInboxWatcher(pi, ctx).catch((err) => {
      console.warn("[lead-worker] startPairInboxWatcher failed:", err);
    });
  };

  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", async (event) => {
    rt.lastObservedPlannerModel = { provider: event.model.provider, modelId: event.model.id };
  });

  pi.on("turn_end", async (_event, ctx) => {
    await maybeAutoReportBuilderCompletion(pi, ctx);
  });
}
