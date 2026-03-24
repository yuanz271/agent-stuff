import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadPlanBuildSettings,
  type PlanBuildSettings,
  type PlanBuildSettingsLoadResult,
  type PlanBuildSource,
} from "./settings.js";
import { getBuilderStatus, startBuilder, stopBuilder } from "./utils.js";
import type { BuilderStatus, PlannerSessionBinding } from "./utils.js";

const STATUS_KEY = "plan-build";
const TOOL_NAME = "plan_build";
const STATE_ENTRY_TYPE = "plan-build-state";
const CONTEXT_MESSAGE_TYPE = "plan-build-context";
const BUILD_HANDOFF_MESSAGE_TYPE = "plan-build-handoff";
const PLANNER_HANDOFF_SENDER_PREFIX = "plan-build";
const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
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
  /^\s*uv\s+run\b/i,
  /^\s*curl\b/i,
  /^\s*wget\s+-O\s*-\b/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/,
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

type PlannerMessengerSender = {
  name: string;
  registered: boolean;
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

let modeEnabled = false;
let previousActiveTools: string[] | undefined;
let previousPlannerSelection: PlannerSelection | undefined;
let lastObservedPlannerModel: { provider?: string; modelId?: string } = {};
let currentSettings: PlanBuildSettingsLoadResult | undefined;

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
  if (!currentSettings) {
    throw new Error("plan-build settings are not loaded");
  }
  return currentSettings;
}

function builderSessionReference(): string {
  return currentSettings?.settings.builder.agent_name ?? "the configured builder session";
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
  currentSettings = await loadPlanBuildSettings(cwd, import.meta.url);
  return currentSettings;
}

function getPlannerSessionBinding(ctx: ExtensionContext): PlannerSessionBinding {
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
    provider: lastObservedPlannerModel.provider ?? ctx.model?.provider,
    modelId: lastObservedPlannerModel.modelId ?? ctx.model?.id,
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
        lastObservedPlannerModel = { provider: normalized.provider, modelId: normalized.modelId };
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
    enabled: modeEnabled,
    previousActiveTools,
    previousPlannerSelection,
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
  if (!modeEnabled) return;
  if (!previousActiveTools || previousActiveTools.length === 0) {
    previousActiveTools = pi.getActiveTools();
  }
  pi.setActiveTools(filterPlannerTools(pi, previousActiveTools));
}

async function restoreModeState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await refreshSettings(ctx.cwd ?? process.cwd());

  const restored = restorePersistedState(ctx);
  modeEnabled = restored?.enabled ?? false;
  previousActiveTools = modeEnabled ? restored?.previousActiveTools ?? pi.getActiveTools() : undefined;
  previousPlannerSelection = modeEnabled ? restored?.previousPlannerSelection : undefined;

  if (modeEnabled) {
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
  if (!modeEnabled && !builder.running) return undefined;
  const builderPart = builder.running ? `${builder.agentName}:on (${builder.tmuxSession})` : `${builder.agentName}:off`;
  if (!modeEnabled) return builderPart;
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
  if (modeEnabled) {
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
    provider: lastObservedPlannerModel.provider,
    modelId: lastObservedPlannerModel.modelId,
  });
  const previousPlannerModel = formatPlannerModel(previousPlannerSelection);
  const loadedSettings = requireCurrentSettings();

  return {
    ok: true,
    action,
    modeEnabled,
    plannerReadOnly: modeEnabled,
    message,
    activeTools: pi.getActiveTools(),
    previousActiveTools,
    plannerModel,
    plannerThinkingLevel: pi.getThinkingLevel(),
    configuredPlannerModel: loadedSettings.settings.planner.model,
    configuredPlannerThinkingLevel: loadedSettings.settings.planner.thinking,
    previousPlannerModel,
    previousPlannerThinkingLevel: previousPlannerSelection?.thinkingLevel,
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
  const capturedTools = modeEnabled ? previousActiveTools : pi.getActiveTools();
  const capturedSelection = modeEnabled ? previousPlannerSelection : getCurrentPlannerSelection(pi, ctx);
  const builder = await startBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  const configuredSelection = getConfiguredPlannerSelection(settings);

  modeEnabled = true;
  previousActiveTools = normalizeToolList(pi, capturedTools);
  if (previousActiveTools.length === 0) {
    previousActiveTools = pi.getActiveTools();
  }
  previousPlannerSelection = normalizePlannerSelection(capturedSelection);

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

async function disableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  const toolsToRestore = previousActiveTools;
  const plannerToRestore = previousPlannerSelection;

  modeEnabled = false;
  restoreNormalTools(pi, toolsToRestore);

  const restoreWarning = await applyPlannerSelection(pi, ctx, plannerToRestore);

  previousActiveTools = undefined;
  previousPlannerSelection = undefined;
  persistModeState(pi);
  updateStatusLine(ctx, builder);

  const restoreTarget = formatPlannerModel(plannerToRestore);
  const restoreMessage = restoreWarning
    ? `Planner model restore was skipped (${restoreWarning})`
    : restoreTarget
      ? `Planner restored to ${restoreTarget}${plannerToRestore?.thinkingLevel ? ` (${plannerToRestore.thinkingLevel})` : ""}`
      : "Planner returned to its prior model state";

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
    `Plan-build mode is ${modeEnabled ? "on" : "off"}. Planner model is ${formatPlannerModel(getCurrentPlannerSelection(pi, ctx)) ?? "unknown"}. Builder ${builder.agentName} is ${builder.running ? "running" : "not running"}.`,
    builder,
    pi,
  );
}

async function stopOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlanBuildSettings): Promise<PlanBuildStatus> {
  const builder = await stopBuilder(pi, ctx.cwd ?? process.cwd(), settings, getPlannerSessionBinding(ctx));
  updateStatusLine(ctx, builder);
  const suffix = modeEnabled ? " Plan-build mode remains on." : "";
  return buildStatus("stop", `Builder ${builder.agentName} forcibly terminated.${suffix}`, builder, pi);
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
  return modeEnabled ? "off" : "on";
}

function fallbackPlannerSenderName(ctx: ExtensionContext): string {
  const shortSessionId = ctx.sessionManager.getSessionId().replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 8) || "planner";
  return `${PLANNER_HANDOFF_SENDER_PREFIX}-${shortSessionId}`;
}

async function resolvePlannerMessengerSender(ctx: ExtensionContext): Promise<PlannerMessengerSender> {
  const fallback: PlannerMessengerSender = {
    name: fallbackPlannerSenderName(ctx),
    registered: false,
  };
  const registryDir = join(process.env.PI_MESSENGER_DIR || join(homedir(), ".pi", "agent", "messenger"), "registry");

  let files: string[];
  try {
    files = await fs.readdir(registryDir);
  } catch {
    return fallback;
  }

  const currentSessionId = ctx.sessionManager.getSessionId();
  const currentPid = process.pid;
  const currentCwd = resolve(ctx.cwd ?? process.cwd());
  let pidMatch: string | undefined;

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const parsed = JSON.parse(await fs.readFile(join(registryDir, file), "utf8")) as {
        name?: unknown;
        pid?: unknown;
        sessionId?: unknown;
        cwd?: unknown;
      };
      if (typeof parsed.name !== "string" || !parsed.name.trim()) continue;

      const sameSession = parsed.sessionId === currentSessionId;
      const samePid = parsed.pid === currentPid;
      const sameCwd = typeof parsed.cwd === "string" && resolve(parsed.cwd) === currentCwd;

      if (sameSession && samePid) {
        return { name: parsed.name, registered: true };
      }
      if (sameSession || (samePid && sameCwd)) {
        pidMatch ??= parsed.name;
      }
    } catch {
      // ignore unreadable messenger registration entries
    }
  }

  if (pidMatch) {
    return { name: pidMatch, registered: true };
  }

  return fallback;
}

function buildHandoffText(ctx: ExtensionContext, extraInstructions: string, plannerSender: PlannerMessengerSender): string | null {
  const recent = getMessagesSinceLastUser(ctx);
  const trimmedExtra = extraInstructions.trim();
  if (recent.length === 0 && !trimmedExtra) return null;

  const lines = [
    `Planner handoff from session ${ctx.sessionManager.getSessionId()} in ${ctx.cwd ?? process.cwd()}.`,
    `Implement the agreed plan in the builder dedicated to this planner session. The planner remains read-only.`,
    plannerSender.registered
      ? `Planner messenger sender: ${plannerSender.name}.`
      : `Planner messenger sender: ${plannerSender.name} (handoff-only; the planner is not currently joined to pi_messenger).`,
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
    plannerSender.registered
      ? `- when useful, send concise progress or blocker updates to ${plannerSender.name} via pi_messenger`
      : "- do not treat inability to reply via pi_messenger as a blocker; proceed with implementation and use normal session output for progress",
    "- if blocked on the task itself, report the minimal blocker and the next action needed",
  );

  return lines.join("\n").trim();
}

async function queueBuilderMessage(
  text: string,
  targetAgentName: string,
  plannerSenderName: string,
): Promise<{ inboxPath: string; registrationVisible: boolean }> {
  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi", "agent", "messenger");
  const targetInbox = join(baseDir, "inbox", targetAgentName);
  const registrationPath = join(baseDir, "registry", `${targetAgentName}.json`);
  await fs.mkdir(targetInbox, { recursive: true });

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const inboxPath = join(targetInbox, fileName);
  await fs.writeFile(
    inboxPath,
    JSON.stringify(
      {
        id: randomUUID(),
        from: plannerSenderName,
        to: targetAgentName,
        text,
        timestamp: new Date().toISOString(),
        replyTo: null,
      },
      null,
      2,
    ),
    "utf8",
  );

  let registrationVisible = false;
  try {
    await fs.access(registrationPath);
    registrationVisible = true;
  } catch {
    registrationVisible = false;
  }

  return { inboxPath, registrationVisible };
}

function formatBuildQueuedMarkdown(
  builder: BuilderStatus,
  queuedPath: string,
  registrationVisible: boolean,
  plannerSender: PlannerMessengerSender,
): string {
  const lines = [
    `**build delegated**`,
    "",
    `- planner mode: ${modeEnabled ? "on" : "off"}`,
    `- planner session id: ${builder.plannerSessionId}`,
    `- planner messenger sender: ${plannerSender.name}${plannerSender.registered ? " (registered)" : " (handoff-only; planner not joined to pi_messenger)"}`,
    `- builder name: ${builder.agentName}`,
    `- builder running: ${builder.running ? "yes" : "no"}`,
    `- builder session: ${builder.tmuxSession}`,
    `- queued inbox file: ${queuedPath}`,
  ];

  if (!plannerSender.registered) {
    lines.push("- note: planner is not joined to pi_messenger, so builder replies through pi_messenger are currently unavailable; the builder should continue without treating that as a blocker.");
    lines.push("- note: if you want bidirectional planner↔builder messaging, join the planner to pi_messenger before running /build.");
  }

  if (!registrationVisible) {
    lines.push(`- note: builder messenger registration is not visible yet; the message is queued and will be processed once ${builder.agentName} joins messenger.`);
  }

  return lines.join("\n");
}

async function handleBuildDelegation(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  if (!modeEnabled) {
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.hasUI && ctx.ui.notify("Wait for the planner to finish its current turn before delegating with /build.", "warning");
    return;
  }

  const { settings } = await refreshSettings(ctx.cwd ?? process.cwd());
  const plannerSender = await resolvePlannerMessengerSender(ctx);
  const handoff = buildHandoffText(ctx, args, plannerSender);
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

  const queued = await queueBuilderMessage(handoff, builder.agentName, plannerSender.name);
  emitInfo(pi, formatBuildQueuedMarkdown(builder, queued.inboxPath, queued.registrationVisible, plannerSender), BUILD_HANDOFF_MESSAGE_TYPE);
}

export default function planBuildExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Plan Build",
    description:
      "Manage planner/build mode and the planner-session-scoped builder configured by plan-build-settings.yaml. " +
      "Actions: start, on, status, off, stop. " +
      "start spawns the current planner session's builder without changing planner mode; on enables read-only planner mode, switches the planner to the configured plan model, and starts the builder if needed; off restores normal planner behavior and restores the previous planner model/thinking; stop forcibly terminates the current planner session's builder.",
    parameters: Type.Object({
      action: StringEnum(["start", "on", "status", "off", "stop"] as const, {
        description: "Plan-build control action for planner mode and the current planner session's builder",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
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
    description: "Control plan-build mode and the current planner session's builder: /plan-build [start|on|status|off|stop] (bare command toggles mode; on switches planner model, off restores it)",
    handler: async (args, ctx) =>
      handleControlCommand(args, ctx, "Usage: /plan-build [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("plan", {
    description: "Alias for /plan-build (bare command toggles mode; on switches planner model, off restores it)",
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
    if (!modeEnabled) return;

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

    if (event.toolName === TOOL_NAME || event.toolName === "pi_messenger") {
      return {
        block: true,
        reason: `plan-build mode is on: planner-side builder control and messaging should go through explicit slash commands (/plan-build, /plan, /build), not model tool calls.`,
      };
    }
  });

  pi.on("context", async (event) => {
    if (modeEnabled) return;
    return {
      messages: event.messages.filter((message) => {
        if (message.role !== "custom") return true;
        return message.customType !== CONTEXT_MESSAGE_TYPE;
      }),
    };
  });

  pi.on("before_agent_start", async () => {
    if (!modeEnabled) return;

    const lines = [
      "[PLAN-BUILD MODE ACTIVE]",
      "You are the planner half of a planner→builder workflow.",
      "",
      "Planner rules:",
      "- Stay read-only. Do not modify files directly.",
      "- Do not use mutating bash commands.",
      "- Do not communicate with the builder through tools on your own.",
      "- Focus on understanding the codebase, producing plans, reviewing results, and preparing precise build instructions.",
      "- When the user wants execution, they will run /build to delegate the current plan to the builder dedicated to this planner session.",
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
    lastObservedPlannerModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
    await restoreModeState(pi, ctx).catch(() => {});
  };

  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", async (event) => {
    lastObservedPlannerModel = { provider: event.model.provider, modelId: event.model.id };
  });
}
