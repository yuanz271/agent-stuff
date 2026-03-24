import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILDER_AGENT_NAME, getBuilderStatus, startBuilder, stopBuilder } from "./utils.js";
import type { BuilderStatus, PlanBuildAction as BuilderLifecycleAction } from "./utils.js";

const STATUS_KEY = "plan-build";
const TOOL_NAME = "plan_build";
const STATE_ENTRY_TYPE = "plan-build-state";
const CONTEXT_MESSAGE_TYPE = "plan-build-context";
const BUILD_HANDOFF_MESSAGE_TYPE = "plan-build-handoff";
const PLANNER_AGENT_NAME = "planner";
const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
const PLANNER_ALLOWED_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "websearch"]);
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

type PersistedPlanBuildState = {
  enabled: boolean;
  previousActiveTools?: string[];
  updatedAt: string;
};

type ExtractedMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type PlanBuildStatus = {
  ok: true;
  action: PlanBuildControlAction;
  modeEnabled: boolean;
  plannerReadOnly: boolean;
  message: string;
  activeTools: string[];
  previousActiveTools?: string[];
  builder: BuilderStatus;
};

let modeEnabled = false;
let previousActiveTools: string[] | undefined;

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

function validToolNames(pi: ExtensionAPI): Set<string> {
  return new Set(pi.getAllTools().map((tool) => tool.name));
}

function filterPlannerTools(pi: ExtensionAPI, sourceTools: string[]): string[] {
  const valid = validToolNames(pi);
  const filtered = sourceTools.filter((name, index) => sourceTools.indexOf(name) === index && valid.has(name) && PLANNER_ALLOWED_TOOLS.has(name));
  if (filtered.length > 0) return filtered;
  return Array.from(valid).filter((name) => PLANNER_ALLOWED_TOOLS.has(name));
}

function normalizeToolList(pi: ExtensionAPI, sourceTools: string[] | undefined): string[] {
  if (!sourceTools || sourceTools.length === 0) return [];
  const valid = validToolNames(pi);
  return sourceTools.filter((name, index) => sourceTools.indexOf(name) === index && valid.has(name));
}

function persistModeState(pi: ExtensionAPI): void {
  pi.appendEntry<PersistedPlanBuildState>(STATE_ENTRY_TYPE, {
    enabled: modeEnabled,
    previousActiveTools,
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
  const restored = restorePersistedState(ctx);
  modeEnabled = restored?.enabled ?? false;
  previousActiveTools = modeEnabled ? restored?.previousActiveTools ?? pi.getActiveTools() : undefined;

  if (modeEnabled) {
    applyPlannerMode(pi);
  }

  const builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd()).catch(() => undefined);
  if (builder) updateStatusLine(ctx, builder);
}

function renderSummary(builder: BuilderStatus): string | undefined {
  if (!modeEnabled && !builder.running) return undefined;
  const builderPart = builder.running ? `${BUILDER_AGENT_NAME}:on (${builder.tmuxSession})` : `${BUILDER_AGENT_NAME}:off`;
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
      ? theme.fg("accent", `${BUILDER_AGENT_NAME}:on (${builder.tmuxSession})`)
      : theme.fg("muted", `${BUILDER_AGENT_NAME}:off`);
    ctx.ui.setStatus(STATUS_KEY, `${plannerPart} | ${builderPart}`);
    return;
  }

  const builderPart = builder.running
    ? theme.fg("accent", `${BUILDER_AGENT_NAME}:on (${builder.tmuxSession})`)
    : theme.fg("muted", `${BUILDER_AGENT_NAME}:off`);
  ctx.ui.setStatus(STATUS_KEY, builderPart);
}

function buildStatus(action: PlanBuildControlAction, message: string, builder: BuilderStatus, pi: ExtensionAPI): PlanBuildStatus {
  return {
    ok: true,
    action,
    modeEnabled,
    plannerReadOnly: modeEnabled,
    message,
    activeTools: pi.getActiveTools(),
    previousActiveTools,
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
    `- active tools: ${status.activeTools.length > 0 ? status.activeTools.join(", ") : "(none)"}`,
    "",
    "**builder**",
    "",
    `- running: ${status.builder.running ? "yes" : "no"}`,
    `- name: ${status.builder.agentName}`,
    `- model: ${status.builder.model}`,
    `- tmux session: ${status.builder.tmuxSession}`,
    `- session file: ${status.builder.sessionFile}`,
    `- log file: ${status.builder.logFile}`,
    `- launch script: ${status.builder.launchScript}`,
  ];

  if (status.builder.startedAt) lines.push(`- started: ${status.builder.startedAt}`);
  if (status.builder.lastStoppedAt) lines.push(`- last stopped: ${status.builder.lastStoppedAt}`);
  if (status.builder.alreadyRunning) lines.push(`- note: existing ${BUILDER_AGENT_NAME} session reused`);

  if (status.builder.warnings.length > 0) {
    lines.push("", "**warnings**", "");
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

async function startOnly(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PlanBuildStatus> {
  const builder = await startBuilder(pi, ctx.cwd ?? process.cwd());
  updateStatusLine(ctx, builder);
  return buildStatus("start", builder.message, builder, pi);
}

async function enableMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PlanBuildStatus> {
  const capturedTools = modeEnabled ? previousActiveTools : pi.getActiveTools();
  const builder = await startBuilder(pi, ctx.cwd ?? process.cwd());

  modeEnabled = true;
  previousActiveTools = normalizeToolList(pi, capturedTools);
  if (previousActiveTools.length === 0) {
    previousActiveTools = pi.getActiveTools();
  }
  applyPlannerMode(pi);
  persistModeState(pi);
  updateStatusLine(ctx, builder);

  return buildStatus(
    "on",
    `Plan-build mode enabled. Planner is now read-only. ${builder.message}`,
    builder,
    pi,
  );
}

async function disableMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PlanBuildStatus> {
  const builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd());
  const toolsToRestore = previousActiveTools;

  modeEnabled = false;
  restoreNormalTools(pi, toolsToRestore);
  previousActiveTools = undefined;
  persistModeState(pi);
  updateStatusLine(ctx, builder);

  return buildStatus(
    "off",
    `Plan-build mode disabled. Planner returned to normal mode. ${builder.running ? `Builder ${BUILDER_AGENT_NAME} is still running.` : `Builder ${BUILDER_AGENT_NAME} is not running.`}`,
    builder,
    pi,
  );
}

async function statusOnly(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PlanBuildStatus> {
  const builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd());
  updateStatusLine(ctx, builder);
  return buildStatus(
    "status",
    `Plan-build mode is ${modeEnabled ? "on" : "off"}. Builder is ${builder.running ? "running" : "not running"}.`,
    builder,
    pi,
  );
}

async function stopOnly(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PlanBuildStatus> {
  const builder = await stopBuilder(pi, ctx.cwd ?? process.cwd());
  updateStatusLine(ctx, builder);
  const suffix = modeEnabled ? " Plan-build mode remains on." : "";
  return buildStatus("stop", `Builder ${BUILDER_AGENT_NAME} forcibly terminated.${suffix}`, builder, pi);
}

async function runControlAction(pi: ExtensionAPI, ctx: ExtensionContext, action: PlanBuildControlAction): Promise<PlanBuildStatus> {
  switch (action) {
    case "start":
      return startOnly(pi, ctx);
    case "on":
      return enableMode(pi, ctx);
    case "status":
      return statusOnly(pi, ctx);
    case "off":
      return disableMode(pi, ctx);
    case "stop":
      return stopOnly(pi, ctx);
  }
}

async function resolveCommandAction(raw: string): Promise<PlanBuildControlAction | null> {
  const explicit = normalizeControlAction(raw);
  if (explicit) return explicit;
  if (raw.trim() !== "") return null;
  return modeEnabled ? "off" : "on";
}

function buildHandoffText(ctx: ExtensionContext, extraInstructions: string): string | null {
  const recent = getMessagesSinceLastUser(ctx);
  const trimmedExtra = extraInstructions.trim();
  if (recent.length === 0 && !trimmedExtra) return null;

  const lines = [
    `Planner handoff from session ${ctx.sessionManager.getSessionId()} in ${ctx.cwd ?? process.cwd()}.`,
    `Implement the agreed plan in the persistent builder session. The planner remains read-only.`,
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
    "- if blocked, report the minimal blocker and the next action needed",
  );

  return lines.join("\n").trim();
}

async function queueBuilderMessage(text: string): Promise<{ inboxPath: string; registrationVisible: boolean }> {
  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi", "agent", "messenger");
  const targetInbox = join(baseDir, "inbox", BUILDER_AGENT_NAME);
  const registrationPath = join(baseDir, "registry", `${BUILDER_AGENT_NAME}.json`);
  await fs.mkdir(targetInbox, { recursive: true });

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const inboxPath = join(targetInbox, fileName);
  await fs.writeFile(
    inboxPath,
    JSON.stringify(
      {
        id: randomUUID(),
        from: PLANNER_AGENT_NAME,
        to: BUILDER_AGENT_NAME,
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

function formatBuildQueuedMarkdown(builder: BuilderStatus, queuedPath: string, registrationVisible: boolean): string {
  const lines = [
    `**build delegated**`,
    "",
    `- planner mode: ${modeEnabled ? "on" : "off"}`,
    `- builder running: ${builder.running ? "yes" : "no"}`,
    `- builder session: ${builder.tmuxSession}`,
    `- queued inbox file: ${queuedPath}`,
  ];

  if (!registrationVisible) {
    lines.push(`- note: builder messenger registration is not visible yet; the message is queued and will be processed once ${BUILDER_AGENT_NAME} joins messenger.`);
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

  const handoff = buildHandoffText(ctx, args);
  if (!handoff) {
    ctx.hasUI && ctx.ui.notify("No recent planner context found. Ask the planner first or pass explicit instructions to /build.", "error");
    return;
  }

  let builder = await getBuilderStatus(pi, ctx.cwd ?? process.cwd());
  if (!builder.running) {
    builder = await startBuilder(pi, ctx.cwd ?? process.cwd());
    updateStatusLine(ctx, builder);
  }

  const queued = await queueBuilderMessage(handoff);
  emitInfo(pi, formatBuildQueuedMarkdown(builder, queued.inboxPath, queued.registrationVisible), BUILD_HANDOFF_MESSAGE_TYPE);
}

export default function planBuildExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Plan Build",
    description:
      `Manage planner/build mode and the persistent builder session ${BUILDER_AGENT_NAME}. ` +
      `Actions: start, on, status, off, stop. ` +
      `start spawns the builder without changing planner mode; on enables read-only planner mode and starts the builder if needed; off restores normal planner behavior; stop forcibly terminates the builder session.`,
    parameters: Type.Object({
      action: StringEnum(["start", "on", "status", "off", "stop"] as const, {
        description: `Plan-build control action for planner mode and builder ${BUILDER_AGENT_NAME}`,
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
    description: `Control plan-build mode and builder ${BUILDER_AGENT_NAME}: /plan-build [start|on|status|off|stop] (bare command toggles mode)`,
    handler: async (args, ctx) =>
      handleControlCommand(args, ctx, "Usage: /plan-build [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("plan", {
    description: "Alias for /plan-build (bare command toggles mode)",
    handler: async (args, ctx) =>
      handleControlCommand(args, ctx, "Usage: /plan [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("pb", {
    description: "Alias for /plan-build (bare command toggles mode)",
    handler: async (args, ctx) =>
      handleControlCommand(args, ctx, "Usage: /pb [start|on|status|off|stop] (no args toggles mode)"),
  });

  pi.registerCommand("build", {
    description: `Delegate the latest planner context to ${BUILDER_AGENT_NAME}. Does nothing when plan-build mode is off.`,
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
        reason: `plan-build mode is on: the planner is read-only. Use /build to delegate execution to ${BUILDER_AGENT_NAME}.`,
      };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isSafePlannerBash(command)) {
        return {
          block: true,
          reason: `plan-build mode is on: mutating bash is blocked for the planner. Use /build to delegate execution to ${BUILDER_AGENT_NAME}.\nCommand: ${command}`,
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

    return {
      message: {
        customType: CONTEXT_MESSAGE_TYPE,
        content: `[PLAN-BUILD MODE ACTIVE]\nYou are the planner half of a planner→builder workflow.\n\nPlanner rules:\n- Stay read-only. Do not modify files directly.\n- Do not use mutating bash commands.\n- Do not communicate with the builder through tools on your own.\n- Focus on understanding the codebase, producing plans, reviewing results, and preparing precise build instructions.\n- When the user wants execution, they will run /build to delegate the current plan to the persistent builder session.\n- Prefer concise builder handoff packets with: goal, relevant files, implementation steps, and validation.`,
        display: false,
      },
    };
  });

  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    await restoreModeState(pi, ctx).catch(() => {});
  };

  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_tree", restore);
}
