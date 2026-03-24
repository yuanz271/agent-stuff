import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { BUILDER_AGENT_NAME, formatStatusMarkdown, getBuilderStatus, startBuilder, stopBuilder } from "./utils.js";
import type { PlanBuildAction } from "./utils.js";

const STATUS_KEY = "plan-build";
const TOOL_NAME = "plan_build";

function resolveExplicitCommandAction(raw: string): PlanBuildAction | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return "status";
  if (value === "status") return "status";
  if (value === "start") return "start";
  if (value === "stop") return "stop";
  return null;
}

function renderSummary(status: Awaited<ReturnType<typeof getBuilderStatus>>): string {
  return status.running ? `${BUILDER_AGENT_NAME}:on (${status.tmuxSession})` : `${BUILDER_AGENT_NAME}:off`;
}

function updateStatusLine(ctx: ExtensionContext, status: Awaited<ReturnType<typeof getBuilderStatus>>): void {
  if (!ctx.hasUI) return;
  if (status.running) {
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", renderSummary(status)));
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function emitInfo(pi: ExtensionAPI, markdown: string): void {
  pi.sendMessage(
    {
      customType: "plan-build",
      content: markdown,
      display: true,
    },
    { triggerTurn: false },
  );
}

async function runAction(pi: ExtensionAPI, ctx: ExtensionContext, action: PlanBuildAction) {
  if (action === "start") return startBuilder(pi, ctx.cwd ?? process.cwd());
  if (action === "stop") return stopBuilder(pi, ctx.cwd ?? process.cwd());
  return getBuilderStatus(pi, ctx.cwd ?? process.cwd());
}

export default function planBuildExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Plan Build",
    description:
      `Manage the persistent builder session ${BUILDER_AGENT_NAME} for planner→builder workflows. ` +
      `Actions: start, status, stop. start launches a detached tmux-backed Pi session pinned to ${BUILDER_AGENT_NAME} ` +
      `with fixed session/model invariants; communication should happen via pi_messenger once ${BUILDER_AGENT_NAME} is running.`,
    parameters: Type.Object({
      action: StringEnum(["start", "status", "stop"] as const, {
        description: `Lifecycle action to perform for builder ${BUILDER_AGENT_NAME}`,
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const status = await runAction(pi, ctx, params.action);
        updateStatusLine(ctx, status);
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

  async function handleCommand(
    args: string,
    ctx: ExtensionContext,
    usage: string,
    resolveAction: (args: string, ctx: ExtensionContext) => Promise<PlanBuildAction | null>,
  ) {
    let action: PlanBuildAction | null = null;
    try {
      action = await resolveAction(args, ctx);
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
      const status = await runAction(pi, ctx, action);
      updateStatusLine(ctx, status);
      emitInfo(pi, formatStatusMarkdown(status));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.hasUI && ctx.ui.notify(`plan-build failed: ${message}`, "error");
    }
  }

  pi.registerCommand("plan-build", {
    description: `Manage the persistent builder session ${BUILDER_AGENT_NAME}: /plan-build [start|status|stop]`,
    handler: async (args, ctx) =>
      handleCommand(args, ctx, "Usage: /plan-build [start|status|stop]", async (value) => resolveExplicitCommandAction(value)),
  });

  pi.registerCommand("pb", {
    description: "Alias for /plan-build",
    handler: async (args, ctx) =>
      handleCommand(args, ctx, "Usage: /pb [start|status|stop]", async (value) => resolveExplicitCommandAction(value)),
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      updateStatusLine(ctx, await getBuilderStatus(pi, ctx.cwd ?? process.cwd()));
    } catch {
      // best effort only
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    try {
      updateStatusLine(ctx, await getBuilderStatus(pi, ctx.cwd ?? process.cwd()));
    } catch {
      // best effort only
    }
  });
}
