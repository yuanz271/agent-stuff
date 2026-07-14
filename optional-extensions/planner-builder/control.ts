import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlannerBuilderSettings } from "./settings.js";
import {
  getBuilderStatus,
  startBuilder,
  stopBuilder,
  type BuilderStatus,
} from "./utils.js";
import {
  BUILD_HANDOFF_MESSAGE_TYPE,
  STATE_ENTRY_TYPE,
  STATUS_KEY,
  TOOL_NAME,
  type PlannerSelection,
  type PlannerBuilderControlAction,
  type PlannerBuilderStatus,
  type PersistedPlannerBuilderState,
  rt,
  currentPairRole,
  getConfiguredPlannerSelection,
  getContextCwd,
  getPlannerSessionBinding,
  requireCurrentSettings,
  refreshSettings,
} from "./runtime.js";

export type PrimePlannerConnection = (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;

export function normalizeControlAction(raw: string): PlannerBuilderControlAction | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (value === "start") return "start";
  if (value === "on") return "on";
  if (value === "status") return "status";
  if (value === "off") return "off";
  if (value === "stop") return "stop";
  return null;
}

function validToolNames(pi: ExtensionAPI): Set<string> {
  return new Set(pi.getAllTools().map((tool) => tool.name));
}

function filterPlannerTools(pi: ExtensionAPI, sourceTools: string[]): string[] {
  const valid = validToolNames(pi);
  const allowed = new Set(requireCurrentSettings().settings.planner.allowed_tools);
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

export function formatPlannerModel(selection: PlannerSelection | undefined): string | undefined {
  if (!selection?.provider || !selection.modelId) return undefined;
  return `${selection.provider}/${selection.modelId}`;
}

export function getCurrentPlannerSelection(pi: ExtensionAPI, ctx: ExtensionContext): PlannerSelection {
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
  pi.appendEntry<PersistedPlannerBuilderState>(STATE_ENTRY_TYPE, {
    enabled: rt.modeEnabled,
    previousActiveTools: rt.previousActiveTools,
    previousPlannerSelection: rt.previousPlannerSelection,
    updatedAt: new Date().toISOString(),
  });
}

function restorePersistedState(ctx: ExtensionContext): PersistedPlannerBuilderState | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as PersistedPlannerBuilderState | undefined;
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

function renderSummary(builder: BuilderStatus): string | undefined {
  if (!rt.modeEnabled && !builder.running) return undefined;
  const builderPart = builder.running ? `${builder.agentName}:on` : `${builder.agentName}:off`;
  if (!rt.modeEnabled) return builderPart;
  return `planner:on | ${builderPart}`;
}

export function updateStatusLine(ctx: ExtensionContext, builder: BuilderStatus): void {
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
      ? theme.fg("accent", `${builder.agentName}:on`)
      : theme.fg("muted", `${builder.agentName}:off`);
    ctx.ui.setStatus(STATUS_KEY, `${plannerPart} | ${builderPart}`);
    return;
  }

  const builderPart = builder.running
    ? theme.fg("accent", `${builder.agentName}:on`)
    : theme.fg("muted", `${builder.agentName}:off`);
  ctx.ui.setStatus(STATUS_KEY, builderPart);
}

function buildStatus(action: PlannerBuilderControlAction, message: string, builder: BuilderStatus, pi: ExtensionAPI): PlannerBuilderStatus {
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

export function formatStatusMarkdown(status: PlannerBuilderStatus): string {
  const lines = [
    `**planner-builder ${status.action}**`,
    "",
    `- message: ${status.message}`,
    `- planner mode: ${status.modeEnabled ? "on" : "off"}`,
    `- planner behavior: ${status.plannerReadOnly ? "planner (no direct repo edits)" : "normal"}`,
    `- planner model: ${status.plannerModel ?? "unknown"}`,
    `- planner thinking: ${status.plannerThinkingLevel}`,
    `- configured planner model: ${status.configuredPlannerModel}`,
    `- configured planner thinking: ${status.configuredPlannerThinkingLevel}`,
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
    `- pair id: ${status.builder.pairId}`,
    `- model: ${status.builder.model}`,
    `- thinking: ${status.builder.thinking}`,
    ...(status.builder.plannerSessionId ? [`- last planner session id: ${status.builder.plannerSessionId}`] : []),
    `- tmux session: ${status.builder.tmuxSession}`,
    `- session file: ${status.builder.sessionFile}`,
    `- log file: ${status.builder.logFile}`,
    `- launch script: ${status.builder.launchScript}`,
    `- socket path: ${status.builder.socketPath}`,
  );

  if (status.builder.plannerSessionFile) lines.push(`- last planner session file: ${status.builder.plannerSessionFile}`);
  if (status.builder.startedAt) lines.push(`- started: ${status.builder.startedAt}`);
  if (status.builder.lastStoppedAt) lines.push(`- last stopped: ${status.builder.lastStoppedAt}`);
  if (status.builder.alreadyRunning) lines.push(`- note: existing ${status.builder.agentName} session reused`);

  if (status.settingsWarnings.length > 0 || status.builder.warnings.length > 0) {
    lines.push("", "**warnings**", "");
    for (const warning of status.settingsWarnings) lines.push(`- settings: ${warning}`);
    for (const warning of status.builder.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}

export function emitInfo(pi: ExtensionAPI, markdown: string, customType = BUILD_HANDOFF_MESSAGE_TYPE): void {
  pi.sendMessage(
    {
      customType,
      content: markdown,
      display: true,
    },
    { triggerTurn: false },
  );
}

export async function restoreModeState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await refreshSettings(getContextCwd(ctx));

  const restored = restorePersistedState(ctx);
  rt.modeEnabled = restored?.enabled ?? false;
  rt.previousActiveTools = rt.modeEnabled ? restored?.previousActiveTools ?? pi.getActiveTools() : undefined;
  rt.previousPlannerSelection = rt.modeEnabled ? restored?.previousPlannerSelection : undefined;

  if (rt.modeEnabled) {
    applyPlannerMode(pi);
    const warning = await applyPlannerSelection(pi, ctx, getConfiguredPlannerSelection());
    if (warning && ctx.hasUI) ctx.ui.notify(`planner-builder: ${warning}`, "warning");
  }

  const builder = await getBuilderStatus(
    pi,
    getContextCwd(ctx),
    requireCurrentSettings().settings,
    getPlannerSessionBinding(ctx),
  );
  updateStatusLine(ctx, builder);
}

async function startOnly(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: PlannerBuilderSettings,
  primePlannerConnection: PrimePlannerConnection,
): Promise<PlannerBuilderStatus> {
  const builder = await startBuilder(pi, getContextCwd(ctx), settings, getPlannerSessionBinding(ctx));
  updateStatusLine(ctx, builder);
  await primePlannerConnection(pi, ctx);
  return buildStatus("start", builder.message, builder, pi);
}

async function enableMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: PlannerBuilderSettings,
  primePlannerConnection: PrimePlannerConnection,
): Promise<PlannerBuilderStatus> {
  const capturedTools = rt.modeEnabled ? rt.previousActiveTools : pi.getActiveTools();
  const capturedSelection = rt.modeEnabled ? rt.previousPlannerSelection : getCurrentPlannerSelection(pi, ctx);
  const builder = await startBuilder(pi, getContextCwd(ctx), settings, getPlannerSessionBinding(ctx));
  const configuredSelection = getConfiguredPlannerSelection(settings);

  rt.modeEnabled = true;
  rt.previousActiveTools = normalizeToolList(pi, capturedTools);
  if (rt.previousActiveTools.length === 0) rt.previousActiveTools = pi.getActiveTools();
  rt.previousPlannerSelection = normalizePlannerSelection(capturedSelection);

  const switchWarning = await applyPlannerSelection(pi, ctx, configuredSelection);

  applyPlannerMode(pi);
  persistModeState(pi);
  updateStatusLine(ctx, builder);
  await primePlannerConnection(pi, ctx);

  const configuredModelLabel = formatPlannerModel(configuredSelection) ?? settings.planner.model;
  const switchMessage = switchWarning
    ? `Planner remained on ${formatPlannerModel(getCurrentPlannerSelection(pi, ctx)) ?? "the current model"} (${switchWarning})`
    : `Planner switched to ${configuredModelLabel} (${settings.planner.thinking})`;

  return buildStatus(
    "on",
    `Planner-builder mode enabled. Planner now avoids direct repo edits. ${switchMessage}. ${builder.message}`,
    builder,
    pi,
  );
}

async function restorePlannerMode(pi: ExtensionAPI, ctx: ExtensionContext, builder: BuilderStatus): Promise<string> {
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

async function disableMode(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlannerBuilderSettings): Promise<PlannerBuilderStatus> {
  const builder = await getBuilderStatus(pi, getContextCwd(ctx), settings, getPlannerSessionBinding(ctx));
  const restoreMessage = await restorePlannerMode(pi, ctx, builder);
  return buildStatus(
    "off",
    `Planner-builder mode disabled. Planner returned to normal mode. ${restoreMessage}. ${builder.running ? `Builder ${builder.agentName} is still running.` : `Builder ${builder.agentName} is not running.`}`,
    builder,
    pi,
  );
}

async function statusOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlannerBuilderSettings): Promise<PlannerBuilderStatus> {
  const builder = await getBuilderStatus(pi, getContextCwd(ctx), settings, getPlannerSessionBinding(ctx));
  updateStatusLine(ctx, builder);
  return buildStatus(
    "status",
    `Planner-builder mode is ${rt.modeEnabled ? "on" : "off"}. Planner model is ${formatPlannerModel(getCurrentPlannerSelection(pi, ctx)) ?? "unknown"}. Builder ${builder.agentName} is ${builder.running ? "running" : "not running"}.`,
    builder,
    pi,
  );
}

async function stopOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: PlannerBuilderSettings): Promise<PlannerBuilderStatus> {
  rt.activeSupervisedHandoff = undefined;
  rt.pendingClarification = undefined;
  const builder = await stopBuilder(pi, getContextCwd(ctx), settings, getPlannerSessionBinding(ctx));

  if (rt.modeEnabled) {
    const restoreMessage = await restorePlannerMode(pi, ctx, builder);
    return buildStatus("stop", `Builder ${builder.agentName} forcibly terminated. Planner-builder mode disabled. ${restoreMessage}.`, builder, pi);
  }

  updateStatusLine(ctx, builder);
  return buildStatus("stop", `Builder ${builder.agentName} forcibly terminated.`, builder, pi);
}

export async function runControlAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: PlannerBuilderControlAction,
  primePlannerConnection: PrimePlannerConnection,
): Promise<PlannerBuilderStatus> {
  if (currentPairRole() !== "planner") {
    throw new Error(`Planner-builder control action '${action}' is only available from the planner session.`);
  }

  const { settings } = await refreshSettings(getContextCwd(ctx));
  switch (action) {
    case "start": return startOnly(pi, ctx, settings, primePlannerConnection);
    case "on": return enableMode(pi, ctx, settings, primePlannerConnection);
    case "status": return statusOnly(pi, ctx, settings);
    case "off": return disableMode(pi, ctx, settings);
    case "stop": return stopOnly(pi, ctx, settings);
  }
}

export async function resolveCommandAction(raw: string): Promise<PlannerBuilderControlAction | null> {
  const explicit = normalizeControlAction(raw);
  if (explicit) return explicit;
  if (raw.trim() !== "") return null;
  return rt.modeEnabled ? "off" : "on";
}
