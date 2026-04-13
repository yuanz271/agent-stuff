import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { LeadWorkerSettings } from "./settings.js";
import {
  getWorkerStatus,
  startWorker,
  stopWorker,
  type WorkerStatus,
} from "./utils.js";
import {
  BUILD_HANDOFF_MESSAGE_TYPE,
  STATE_ENTRY_TYPE,
  STATUS_KEY,
  TOOL_NAME,
  type LeadSelection,
  type LeadWorkerControlAction,
  type LeadWorkerStatus,
  type PersistedLeadWorkerState,
  rt,
  currentPairRole,
  getConfiguredLeadSelection,
  getContextCwd,
  getLeadSessionBinding,
  requireCurrentSettings,
  refreshSettings,
} from "./runtime.js";

export type PrimeLeadConnection = (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void>;

export function normalizeControlAction(raw: string): LeadWorkerControlAction | null {
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

function filterLeadTools(pi: ExtensionAPI, sourceTools: string[]): string[] {
  const valid = validToolNames(pi);
  const allowed = new Set(requireCurrentSettings().settings.lead.allowed_tools);
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

export function formatLeadModel(selection: LeadSelection | undefined): string | undefined {
  if (!selection?.provider || !selection.modelId) return undefined;
  return `${selection.provider}/${selection.modelId}`;
}

export function getCurrentLeadSelection(pi: ExtensionAPI, ctx: ExtensionContext): LeadSelection {
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

export function updateStatusLine(ctx: ExtensionContext, worker: WorkerStatus): void {
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

export function formatStatusMarkdown(status: LeadWorkerStatus): string {
  const lines = [
    `**lead-worker ${status.action}**`,
    "",
    `- message: ${status.message}`,
    `- lead mode: ${status.modeEnabled ? "on" : "off"}`,
    `- lead behavior: ${status.leadReadOnly ? "lead (no direct repo edits)" : "normal"}`,
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
  rt.previousLeadSelection = rt.modeEnabled ? restored?.previousLeadSelection : undefined;

  if (rt.modeEnabled) {
    applyLeadMode(pi);
    const warning = await applyLeadSelection(pi, ctx, getConfiguredLeadSelection());
    if (warning && ctx.hasUI) ctx.ui.notify(`lead-worker: ${warning}`, "warning");
  }

  const worker = await getWorkerStatus(
    pi,
    getContextCwd(ctx),
    requireCurrentSettings().settings,
    getLeadSessionBinding(ctx),
  );
  updateStatusLine(ctx, worker);
}

async function startOnly(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: LeadWorkerSettings,
  primeLeadConnection: PrimeLeadConnection,
): Promise<LeadWorkerStatus> {
  const worker = await startWorker(pi, getContextCwd(ctx), settings, getLeadSessionBinding(ctx));
  updateStatusLine(ctx, worker);
  await primeLeadConnection(pi, ctx);
  return buildStatus("start", worker.message, worker, pi);
}

async function enableMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: LeadWorkerSettings,
  primeLeadConnection: PrimeLeadConnection,
): Promise<LeadWorkerStatus> {
  const capturedTools = rt.modeEnabled ? rt.previousActiveTools : pi.getActiveTools();
  const capturedSelection = rt.modeEnabled ? rt.previousLeadSelection : getCurrentLeadSelection(pi, ctx);
  const worker = await startWorker(pi, getContextCwd(ctx), settings, getLeadSessionBinding(ctx));
  const configuredSelection = getConfiguredLeadSelection(settings);

  rt.modeEnabled = true;
  rt.previousActiveTools = normalizeToolList(pi, capturedTools);
  if (rt.previousActiveTools.length === 0) rt.previousActiveTools = pi.getActiveTools();
  rt.previousLeadSelection = normalizeLeadSelection(capturedSelection);

  const switchWarning = await applyLeadSelection(pi, ctx, configuredSelection);

  applyLeadMode(pi);
  persistModeState(pi);
  updateStatusLine(ctx, worker);
  await primeLeadConnection(pi, ctx);

  const configuredModelLabel = formatLeadModel(configuredSelection) ?? settings.lead.model;
  const switchMessage = switchWarning
    ? `Lead remained on ${formatLeadModel(getCurrentLeadSelection(pi, ctx)) ?? "the current model"} (${switchWarning})`
    : `Lead switched to ${configuredModelLabel} (${settings.lead.thinking})`;

  return buildStatus(
    "on",
    `Lead-worker mode enabled. Lead now avoids direct repo edits. ${switchMessage}. ${worker.message}`,
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
  const worker = await getWorkerStatus(pi, getContextCwd(ctx), settings, getLeadSessionBinding(ctx));
  const restoreMessage = await restoreLeadMode(pi, ctx, worker);
  return buildStatus(
    "off",
    `Lead-worker mode disabled. Lead returned to normal mode. ${restoreMessage}. ${worker.running ? `Worker ${worker.agentName} is still running.` : `Worker ${worker.agentName} is not running.`}`,
    worker,
    pi,
  );
}

async function statusOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: LeadWorkerSettings): Promise<LeadWorkerStatus> {
  const worker = await getWorkerStatus(pi, getContextCwd(ctx), settings, getLeadSessionBinding(ctx));
  updateStatusLine(ctx, worker);
  return buildStatus(
    "status",
    `Lead-worker mode is ${rt.modeEnabled ? "on" : "off"}. Lead model is ${formatLeadModel(getCurrentLeadSelection(pi, ctx)) ?? "unknown"}. Worker ${worker.agentName} is ${worker.running ? "running" : "not running"}.`,
    worker,
    pi,
  );
}

async function stopOnly(pi: ExtensionAPI, ctx: ExtensionContext, settings: LeadWorkerSettings): Promise<LeadWorkerStatus> {
  rt.activeSupervisedHandoff = undefined;
  rt.pendingClarification = undefined;
  const worker = await stopWorker(pi, getContextCwd(ctx), settings, getLeadSessionBinding(ctx));

  if (rt.modeEnabled) {
    const restoreMessage = await restoreLeadMode(pi, ctx, worker);
    return buildStatus("stop", `Worker ${worker.agentName} forcibly terminated. Lead-worker mode disabled. ${restoreMessage}.`, worker, pi);
  }

  updateStatusLine(ctx, worker);
  return buildStatus("stop", `Worker ${worker.agentName} forcibly terminated.`, worker, pi);
}

export async function runControlAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: LeadWorkerControlAction,
  primeLeadConnection: PrimeLeadConnection,
): Promise<LeadWorkerStatus> {
  if (currentPairRole() !== "lead") {
    throw new Error(`Lead-worker control action '${action}' is only available from the lead session.`);
  }

  const { settings } = await refreshSettings(getContextCwd(ctx));
  switch (action) {
    case "start": return startOnly(pi, ctx, settings, primeLeadConnection);
    case "on": return enableMode(pi, ctx, settings, primeLeadConnection);
    case "status": return statusOnly(pi, ctx, settings);
    case "off": return disableMode(pi, ctx, settings);
    case "stop": return stopOnly(pi, ctx, settings);
  }
}

export async function resolveCommandAction(raw: string): Promise<LeadWorkerControlAction | null> {
  const explicit = normalizeControlAction(raw);
  if (explicit) return explicit;
  if (raw.trim() !== "") return null;
  return rt.modeEnabled ? "off" : "on";
}
