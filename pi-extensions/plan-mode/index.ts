import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { BUILDER_AGENT_NAME, formatStatusMarkdown, getBuilderStatus, startBuilder, stopBuilder } from "./utils.js";
import type { PlanModeAction } from "./utils.js";

const STATUS_KEY = "plan-mode";
const TOOL_NAME = "plan_mode";

function normalizeAction(raw: string): PlanModeAction | null {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "status") return "status";
  if (value === "start" || value === "stop") return value;
  return null;
}

function renderSummary(status: Awaited<ReturnType<typeof getBuilderStatus>>): string {
  return status.running ? `B:on (${status.tmuxSession})` : "B:off";
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
      customType: "plan-mode",
      content: markdown,
      display: true,
    },
    { triggerTurn: false },
  );
}

async function runAction(pi: ExtensionAPI, ctx: ExtensionContext, action: PlanModeAction) {
  if (action === "start") return startBuilder(pi, ctx.cwd ?? process.cwd());
  if (action === "stop") return stopBuilder(pi, ctx.cwd ?? process.cwd());
  return getBuilderStatus(pi, ctx.cwd ?? process.cwd());
}

export default function planModeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Plan Mode",
    description:
      `Manage the persistent builder session ${BUILDER_AGENT_NAME} for planner→builder workflows. ` +
      `Actions: start, status, stop. start launches a detached tmux-backed Pi session pinned to ${BUILDER_AGENT_NAME} ` +
      `with fixed session/model invariants; communication should happen via pi_messenger once B is running.`,
    parameters: Type.Object({
      action: StringEnum(["start", "status", "stop"] as const, {
        description: "Lifecycle action to perform for builder B",
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

  async function handleCommand(args: string, ctx: ExtensionContext, usage: string) {
    const action = normalizeAction(args);
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
      ctx.hasUI && ctx.ui.notify(`plan-mode failed: ${message}`, "error");
    }
  }

  pi.registerCommand("plan-mode", {
    description: "Manage the persistent builder session B: /plan-mode [start|status|stop]",
    handler: async (args, ctx) => handleCommand(args, ctx, "Usage: /plan-mode [start|status|stop]"),
  });

  pi.registerCommand("pm", {
    description: "Alias for /plan-mode",
    handler: async (args, ctx) => handleCommand(args, ctx, "Usage: /pm [start|status|stop]"),
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
