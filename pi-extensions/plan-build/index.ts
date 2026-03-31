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

const STATUS_KEY = "plan-build";
const TOOL_NAME = "plan_build";
const STATE_ENTRY_TYPE = "plan-build-state";
const CONTEXT_MESSAGE_TYPE = "plan-build-context";
const BUILD_HANDOFF_MESSAGE_TYPE = "plan-build-handoff";
const PAIR_MESSAGE_TYPE = "plan-build-pair-message";
const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
const MAX_HANDOFF_CHARS = 32_000;
const BUILDER_RELAY_DEDUP_WINDOW_MS = 60_000;
const BUILDER_AUTO_REPORT_SUMMARY_MAX_CHARS = 3_000;
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
  builder: BuilderStatus;
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

function isSafePlannerBash(command: string): boolean {
  const destructive = MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
  const safe = SAFE_BASH_PREFIXES.some((pattern) => pattern.test(command));
  return safe && !destructive;
}

function requireCurrentSettings(): PlanBuildSettingsLoadResult {
  if (!rt.currentSettings) {
    throw new Error("plan-build settings are not loaded");
  }
  return rt.currentSettings;
}

function builderSessionReference(): string {
  return rt.currentSettings?.settings.builder.agent_name ?? "the configured builder session";
}

function plannerConfig(): PlanBuildSettings["planner"] {
  return requireCurrentSettings().settings.planner;
}

function getConfiguredPlannerSelection(settings: PlanBuildSettings = requireCurrentSettings().settings): PlannerSelection | undefined {
  const ref = settings.planner.model.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator >= ref.length - 1) return undefined;
  return {
    provider: ref.slice(0, separator),
    modelId: ref.slice(separator + 1),
    thinkingLevel: settings.planner.thinking,
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
  const allowed = new Set(plannerConfig().allowed_tools);
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
      ctx.ui.notify(`plan-build: ${warning}`, "warning");
    }
  }

  const builder = await getBuilderStatus(
    pi,
    ctx.cwd ?? process.cwd(),
    requireCurrentSettings().settings,
    getPlannerSessionBinding(ctx),
  ).catch(() => undefined);
  if (builder) updateStatusLine(ctx, builder);
}

function renderSummary(builder: BuilderStatus): string | undefined {
  if (!rt.modeEnabled && !builder.running) return undefined;
  const builderPart = builder.running ? `${builder.agentName}:on (${builder.tmuxSession})` : `${builder.agentName}:off`;
  if (!rt.modeEnabled) return builderPart;
  return `planner:on | ${builderPart}`;
}

function updateStatusLine(ctx: ExtensionContext, builder: BuilderStatus): void {
  if (!ctx.hasUI) return;
  const summary = renderSummary(builder);
  if (!summary) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  if (rt.modeEnabled) {
    const plannerPart = theme.fg("warning", "planner:on");
    const builderPart = builder.running
      ? theme.fg("accent", `${builder.agentName}:on (${builder.tmuxSession})`)
      : theme.fg("muted", `${builder.agentName}:off`);
    ctx.ui.setStatus(STATUS_KEY, `${plannerPart} | ${builderPart}`);
    return;
  }

  const builderPart = builder.running
    ? theme.fg("accent", `${builder.agentName}:on (${builder.tmuxSession})`)
    : theme.fg("muted", `${builder.agentName}:off`);
  ctx.ui.setStatus(STATUS_KEY, builderPart);
}

function buildStatus(action: PlanBuildControlAction, message: string, builder: BuilderStatus, pi: ExtensionAPI): PlanBuildStatus {
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
    configuredPlannerModel: loadedSettings.settings.planner.model,
    configuredPlannerThinkingLevel: loadedSettings.settings.planner.thinking,
    previousPlannerModel,
    previousPlannerThinkingLevel: rt.previousPlannerSelection?.thinkingLevel,
    settingsSources: loadedSettings.stats.loaded_sources,
    settingsWarnings: loadedSettings.warnings,
    settingsInvalidFieldCount: loadedSettings.stats.invalid_field_count,
    builder,
  };
}

function formatStatusMarkdown(status: PlanBuildStatus): string {
  const lines = [
    `**plan-build ${status.action}**`,
    "",
    `- message: ${status.message}`,
    `- planner mode: ${status.modeEnabled ? "on" : "off"}`,
    `- planner behavior: ${status.plannerReadOnly ? "planner (read-only)" : "normal"}`,
    `- planner model: ${status.plannerModel ?? "unknown"}`,
    `- planner thinking: ${status.plannerThinkingLevel}`,
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
    `- running: ${status.builder.running ? "yes" : "no"}`,
    `- name: ${status.builder.agentName}`,
    `- model: ${status.builder.model}`,
    `- thinking: ${status.builder.thinking}`,
    `- planner session id: ${status.builder.plannerSessionId}`,
    `- tmux session: ${status.builder.tmuxSession}`,
    `- session file: ${status.builder.sessionFile}`,
    `- log file: ${status.builder.logFile}`,
    `- launch script: ${status.builder.launchScript}`,
  );

  if (status.builder.plannerSessionFile) lines.push(`- planner session file: ${status.builder.plannerSessionFile}`);
  if (status.builder.startedAt) lines.push(`- started: ${status.builder.startedAt}`);
  if (status.builder.lastStoppedAt) lines.push(`- last stopped: ${status.builder.lastStoppedAt}`);
  if (status.builder.alreadyRunning) lines.push(`- note: existing ${status.builder.agentName} session reused`);

  if (status.settingsWarnings.length > 0 || status.builder.warnings.length > 0) {
    lines.push("", "**warnings**", "");
    for (const warning of status.settingsWarnings) {
      lines.push(`- settings: ${warning}`);
    }
    for (const warning of status.builder.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (status.builder.backlog.length > 0) {
    lines.push("", "**recent builder output**", "", "```text", ...status.builder.backlog, "```");
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
  const builder = await startBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  updateStatusLine(ctx, builder);
  return buildStatus("start", builder.message, builder, pi);
}

async function enableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const capturedTools = rt.modeEnabled ? rt.previousActiveTools : pi.getActiveTools();
  const capturedSelection = rt.modeEnabled ? rt.previousPlannerSelection : getCurrentPlannerSelection(pi, ctx);
  const builder = await startBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
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
  updateStatusLine(ctx, builder);

  const configuredModelLabel = formatPlannerModel(configuredSelection) ?? settings.planner.model;
  const switchMessage = switchWarning
    ? `Planner remained on ${formatPlannerModel(getCurrentPlannerSelection(pi, ctx)) ?? "the current model"} (${switchWarning})`
    : `Planner switched to ${configuredModelLabel} (${settings.planner.thinking})`;

  return buildStatus(
    "on",
    `Plan-build mode enabled. Planner is now read-only. ${switchMessage}. ${builder.message}`,
    builder,
    pi,
  );
}

async function restorePlannerMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  builder: BuilderStatus,
): Promise<string> {
  const toolsToRestore = rt.previousActiveTools;
  const plannerToRestore = rt.previousPlannerSelection;

  rt.modeEnabled = false;
  restoreNormalTools(pi, toolsToRestore);

  const restoreWarning = await applyPlannerSelection(pi, ctx, plannerToRestore);

  rt.previousActiveTools = undefined;
  rt.previousPlannerSelection = undefined;
  persistModeState(pi);
  updateStatusLine(ctx, builder);

  const restoreTarget = formatPlannerModel(plannerToRestore);
  return restoreWarning
    ? `Planner model restore was skipped (${restoreWarning})`
    : restoreTarget
      ? `Planner restored to ${restoreTarget}${plannerToRestore?.thinkingLevel ? ` (${plannerToRestore.thinkingLevel})` : ""}`
      : "Planner returned to its prior model state";
}

async function disableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  const restoreMessage = await restorePlannerMode(pi, ctx, builder);

  return buildStatus(
    "off",
    `Plan-build mode disabled. Planner returned to normal mode. ${restoreMessage}. ${builder.running ? `Builder ${builder.agentName} is still running.` : `Builder ${builder.agentName} is not running.`}`,
    builder,
    pi,
  );
}

async function statusOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  updateStatusLine(ctx, builder);
  return buildStatus(
    "status",
    `Plan-build mode is ${rt.modeEnabled ? "on" : "off"}. Planner model is ${formatPlannerModel(getCurrentPlannerSelection(pi, ctx)) ?? "unknown"}. Builder ${builder.agentName} is ${builder.running ? "running" : "not running"}.`,
    builder,
    pi,
  );
}

async function stopOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const builder = await stopBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));

  if (rt.modeEnabled) {
    const restoreMessage = await restorePlannerMode(pi, ctx, builder);
    return buildStatus(
      "stop",
      `Builder ${builder.agentName} forcibly terminated. Plan-build mode disabled. ${restoreMessage}.`,
      builder,
      pi,
    );
  }

  updateStatusLine(ctx, builder);
  return buildStatus("stop", `Builder ${builder.agentName} forcibly terminated.`, builder, pi);
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
    typeof message.text === "string"
  );
}

function formatIncomingPairMessage(message: PairChannelMessage): string {
  const heading = message.kind === "handoff"
    ? `**plan-build handoff from ${message.from}**`
    : `**plan-build message from ${message.from}**`;
  return [heading, "", `- planner session id: ${message.plannerSessionId}`, "", message.text].join("\n");
}

function normalizeWhitespaceLower(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function pairRelayFingerprint(message: PairChannelMessage): string {
  return `${message.from}|${message.to}|${message.kind}|${message.plannerSessionId}|${normalizeWhitespaceLower(message.text)}`;
}

function isBuilderCompletionMessage(message: PairChannelMessage): boolean {
  if (message.from !== "builder" || message.kind !== "message") return false;

  const normalized = normalizeWhitespaceLower(message.text);
  if (normalized.startsWith("builder completion report")) return true;

  const hasStatus = /\bstatus\s*:\s*(done|blocked)\b/i.test(message.text);
  const hasFiles = /\bfiles\s+changed\s*:/i.test(message.text);
  const hasValidation = /\bvalidation\s*:/i.test(message.text);
  return hasStatus && hasFiles && hasValidation;
}

function maybeRelayBuilderMessageToUser(pi: ExtensionAPI, message: PairChannelMessage): void {
  if (currentPairRole() !== "planner") return;
  if (!isBuilderCompletionMessage(message)) return;

  const now = Date.now();
  const fingerprint = pairRelayFingerprint(message);
  const withinWindow = (rt.lastBuilderRelayAtMs ?? 0) > now - BUILDER_RELAY_DEDUP_WINDOW_MS;
  if (withinWindow && rt.lastBuilderRelayFingerprint === fingerprint) {
    return;
  }

  rt.lastBuilderRelayFingerprint = fingerprint;
  rt.lastBuilderRelayAtMs = now;

  const relayPrompt = [
    "Builder sent a completion update.",
    "Reply to the USER now with a concise status update.",
    "Include: (1) done/blocked, (2) files changed, (3) validation result, (4) next step.",
    "Do not ask the builder to repeat the same report unless critical information is missing.",
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
    "- status: done",
    "- files changed: see latest builder response and diffs",
    "- validation: see latest builder response",
    "- details:",
    truncate(summary, BUILDER_AUTO_REPORT_SUMMARY_MAX_CHARS),
  ].join("\n");

  await queuePairedMessage(pi, ctx, report, "message");
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
          id: parsed.id,
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
  // Keep a lightweight periodic scan so builder→planner messages are eventually delivered.
  rt.pairInboxPollTimer = setInterval(() => {
    if (rt.latestPairContext) {
      void processPendingPairMessages(pi, rt.latestPairContext).catch((err) => {
        console.warn("[plan-build] periodic pair inbox scan failed:", err);
      });
    }
  }, 2_000);
}

async function queuePairedMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
  kind: PairChannelMessage["kind"],
): Promise<{ queuedPath: string; plannerSessionId: string; to: PairRole }> {
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
  };

  const queuedPath = join(targetInboxPath, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeFile(queuedPath, JSON.stringify(message, null, 2), "utf8");
  rt.lastOutboundPairMessageAtMs = Date.now();

  return {
    queuedPath,
    plannerSessionId: plannerSession.sessionId,
    to: message.to,
  };
}

async function sendPairMessageAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rawMessage: string | undefined,
): Promise<{ ok: true; action: "message"; role: PairRole; to: PairRole; plannerSessionId: string; queuedPath: string }> {
  const role = currentPairRole();
  const queued = await queuePairedMessage(pi, ctx, rawMessage ?? "", "message");
  return {
    ok: true,
    action: "message",
    role,
    to: queued.to,
    plannerSessionId: queued.plannerSessionId,
    queuedPath: queued.queuedPath,
  };
}

function buildHandoffText(ctx: ExtensionContext, extraInstructions: string): string | null {
  const recent = getMessagesSinceLastUser(ctx);
  const trimmedExtra = extraInstructions.trim();
  if (recent.length === 0 && !trimmedExtra) return null;

  const lines = [
    `Planner handoff from session ${ctx.sessionManager.getSessionId()} in ${ctx.cwd ?? process.cwd()}.`,
    `Implement the agreed plan in the builder dedicated to this planner session. The planner remains read-only.`,
    'Direct paired communication is available through plan_build({ action: "message", message: "..." }).',
    "",
  ];

  if (trimmedExtra) {
    lines.push("Additional build instruction:", trimmedExtra, "");
  }

  if (recent.length > 0) {
    lines.push("Recent planner exchange:", "");
    for (const message of recent) {
      const role = message.role === "user" ? "User" : "Planner";
      lines.push(`${role}:`, message.content, "");
    }
  }

  lines.push(
    "Execution expectations:",
    "- implement the requested change in the builder session",
    "- run the smallest relevant validation",
    '- send exactly one completion message to the planner for this handoff via plan_build({ action: "message", message: "..." }) including status, files changed, and validation results',
    '- additional planner messages are only for material blockers or concrete clarification questions',
    "- if blocked on the task itself, report the minimal blocker and the next action needed",
  );

  const joined = lines.join("\n").trim();
  return joined.length <= MAX_HANDOFF_CHARS ? joined : joined.slice(0, MAX_HANDOFF_CHARS - 1) + "…";
}

function formatBuildQueuedMarkdown(builder: BuilderStatus, queuedPath: string): string {
  const lines = [
    `**build delegated**`,
    "",
    `- planner mode: ${rt.modeEnabled ? "on" : "off"}`,
    `- planner session id: ${builder.plannerSessionId}`,
    `- builder name: ${builder.agentName}`,
    `- builder running: ${builder.running ? "yes" : "no"}`,
    `- builder session: ${builder.tmuxSession}`,
    `- queued pair-message file: ${queuedPath}`,
    `- paired transport: internal plan-build mailbox`,
  ];

  return lines.join("\n");
}

async function handleBuildDelegation(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  if (!rt.modeEnabled) {
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.hasUI && ctx.ui.notify("Wait for the planner to finish its current turn before delegating with /build.", "warning");
    return;
  }

  const { settings } = await refreshSettings(ctx.cwd ?? process.cwd());
  const handoff = buildHandoffText(ctx, args);
  if (!handoff) {
    ctx.hasUI && ctx.ui.notify("No recent planner context found. Ask the planner first or pass explicit instructions to /build.", "error");
    return;
  }

  const plannerSession = getPlannerSessionBinding(ctx);
  let builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd(), settings, plannerSession);
  if (!builder.running) {
    builder = await startBuilder(pi, ctx.cwd ?? process.cwd(), settings, plannerSession);
    updateStatusLine(ctx, builder);
  }

  const queued = await queuePairedMessage(pi, ctx, handoff, "handoff");
  emitInfo(pi, formatBuildQueuedMarkdown(builder, queued.queuedPath), BUILD_HANDOFF_MESSAGE_TYPE);
}

export default function planBuildExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Plan Build",
    description:
      "Manage planner/build mode and the planner-session-scoped builder configured by plan-build-settings.yaml. " +
      "Actions: start, on, status, off, stop, message. " +
      "start spawns the current planner session's builder without changing planner mode; on enables read-only planner mode, switches the planner to the configured plan model, and starts the builder if needed; off restores normal planner behavior and restores the previous planner model/thinking while leaving the builder alone; stop forcibly terminates the current planner session's builder and, if plan-build mode is on, also returns the planner to normal mode; message sends a direct paired planner↔builder note through plan-build's internal mailbox.",
    parameters: Type.Object({
      action: StringEnum(["start", "on", "status", "off", "stop", "message"] as const, {
        description: "Plan-build control action for planner/build mode or direct paired messaging",
      }),
      message: Type.Optional(Type.String({ description: "Required for action='message'. Direct message text for the paired planner or builder." })),
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
      ctx.hasUI && ctx.ui.notify(`plan-build failed: ${message}`, "error");
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
      ctx.hasUI && ctx.ui.notify(`plan-build failed: ${message}`, "error");
    }
  }

  pi.registerCommand("plan-build", {
    description: "Control plan-build mode and the current planner session's builder: /plan-build [start|on|status|off|stop] (bare command toggles mode; on switches planner model, off restores it, stop also exits plan-build mode if it is on)",
    handler: async (args, ctx) =>
      handleControlCommand(args, ctx, "Usage: /plan-build [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("plan", {
    description: "Alias for /plan-build (bare command toggles mode; on switches planner model, off restores it, stop also exits plan-build mode if it is on)",
    handler: async (args, ctx) =>
      handleControlCommand(args, ctx, "Usage: /plan [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("build", {
    description: "Delegate the latest planner context to the current planner session's builder. Does nothing when plan-build mode is off.",
    handler: async (args, ctx) => {
      try {
        await handleBuildDelegation(pi, ctx, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.hasUI && ctx.ui.notify(`build delegation failed: ${message}`, "error");
      }
    },
  });

  pi.on("tool_call", async (event) => {
    if (!rt.modeEnabled) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason: `plan-build mode is on: the planner is read-only. Use /build to delegate execution to ${builderSessionReference()}.`,
      };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isSafePlannerBash(command)) {
        return {
          block: true,
          reason: `plan-build mode is on: mutating bash is blocked for the planner. Use /build to delegate execution to ${builderSessionReference()}.\nCommand: ${command}`,
        };
      }
    }

    if (event.toolName === TOOL_NAME) {
      const action = typeof event.input.action === "string" ? event.input.action : "";
      if (action !== "message") {
        return {
          block: true,
          reason: `plan-build mode is on: planner-side builder lifecycle control should go through explicit slash commands (/plan-build, /plan, /build). The only allowed planner tool call is plan_build({ action: "message", ... }) for concise paired messages.`,
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
      "[PLAN-BUILD MODE ACTIVE]",
      "You are the planner half of a planner→builder workflow.",
      "",
      "Planner rules:",
      "- Stay read-only. Do not modify files directly.",
      "- Do not use mutating bash commands.",
      "- Focus on understanding the codebase, producing plans, reviewing results, and preparing precise build instructions.",
      "- When the user wants execution, they will run /build to delegate the current plan to the builder dedicated to this planner session.",
      '- You may send concise direct messages to the paired builder with plan_build({ action: "message", message: "..." }). Use this for clarifications or course corrections, not chatter.',
      "- The paired builder may also message you directly. Answer only when it materially helps execution.",
      "- Prefer concise builder handoff packets with: goal, relevant files, implementation steps, and validation.",
    ];

    const plannerPromptAppend = plannerConfig().prompt_append;
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
      console.warn("[plan-build] restoreModeState failed:", err);
    });
    await startPairInboxWatcher(pi, ctx).catch((err) => {
      console.warn("[plan-build] startPairInboxWatcher failed:", err);
    });
  };

  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", async (event) => {
    rt.lastObservedPlannerModel = { provider: event.model.provider, modelId: event.model.id };
  });

  pi.on("turn_end", async (_event, ctx) => {
    await maybeAutoReportBuilderCompletion(pi, ctx);
  });
}
