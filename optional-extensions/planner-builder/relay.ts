import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMessage, type PairMessageV2 } from "./protocol.js";
import {
  getBuilderStatus,
  type BuilderStatus,
} from "./utils.js";
import {
  MAX_TRACKED_REPORTED_HANDOFF_IDS,
  PAIR_MESSAGE_TYPE,
  BUILDER_RELAY_DEDUP_WINDOW_MS,
  type ActiveConnection,
  type PendingBuilderHandoff,
  rt,
  currentPairRole,
  getContextCwd,
  getPlannerSessionBinding,
  isTerminalSupervisionEvent,
  refreshSettings,
  truncate,
} from "./runtime.js";
import {
  formatExecutionUpdateMarkdown,
  formatExecutionUpdateRelaySummary,
  isHighSignalBuilderEvent,
  parseExecutionUpdatePayload,
} from "./execution-updates.js";

export type EnsurePlannerConnection = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { autoStart: boolean },
) => Promise<ActiveConnection>;

export type StartRpc = (message: PairMessageV2, socket: ActiveConnection["socket"]) => Promise<PairMessageV2>;

function normalizeWhitespaceLower(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function pairRelayFingerprint(message: PairMessageV2): string {
  const handoffId = message.handoffId ?? "";
  const payloadFingerprint = message.payload === undefined ? "" : JSON.stringify(message.payload);
  return `${message.from}|${message.to}|${message.type}|${message.name ?? ""}|${message.pairId}|${handoffId}|${normalizeWhitespaceLower(message.body ?? "")}|${payloadFingerprint}`;
}

export function inferBuilderEventName(text: string, pendingHandoff: PendingBuilderHandoff | undefined): string {
  const normalized = normalizeWhitespaceLower(text);
  if (/\bstatus\s*:\s*(done|completed)\b/.test(normalized)) return "completed";
  if (/\bstatus\s*:\s*(failed|cancelled)\b/.test(normalized)) return "failed";
  if (/\bstatus\s*:\s*blocked\b/.test(normalized)) return "blocker";
  if (/\bclarification\b/.test(normalized)) return "clarification_needed";
  return pendingHandoff ? "progress" : "message";
}

function builderRelayDedupKey(message: PairMessageV2): string | undefined {
  const handoffId = message.handoffId?.trim();
  const eventName = message.name ?? "event";
  if (!handoffId || !isTerminalSupervisionEvent(eventName)) return undefined;
  return `${handoffId}:terminal`;
}

function rememberReportedBuilderEventKey(key: string): void {
  rt.reportedBuilderEventKeys.add(key);
  if (rt.reportedBuilderEventKeys.size <= MAX_TRACKED_REPORTED_HANDOFF_IDS) return;
  const oldest = rt.reportedBuilderEventKeys.values().next().value;
  if (oldest) rt.reportedBuilderEventKeys.delete(oldest);
}

function formatIncomingProtocolMessage(message: PairMessageV2): string {
  if (message.type === "event" && message.from === "builder" && isHighSignalBuilderEvent(message.name ?? "")) {
    try {
      return formatExecutionUpdateMarkdown(
        parseExecutionUpdatePayload(message.payload, message.name ?? undefined),
        { fromLabel: message.from, pairId: message.pairId },
      );
    } catch (error) {
      return [
        `**planner-builder invalid ${message.name ?? "event"} payload from ${message.from}**`,
        "",
        `- pair id: ${message.pairId}`,
        ...(message.handoffId ? [`- handoff id: ${message.handoffId}`] : []),
        `- error: ${error instanceof Error ? error.message : String(error)}`,
        "",
        message.body ?? "(no body)",
      ].join("\n");
    }
  }

  const heading = message.type === "event"
    ? `**planner-builder event from ${message.from}: ${message.name ?? "event"}**`
    : message.type === "request"
      ? `**planner-builder request from ${message.from}${message.name ? `: ${message.name}` : ""}**`
      : `**planner-builder message from ${message.from}**`;
  return [
    heading,
    "",
    `- pair id: ${message.pairId}`,
    ...(message.handoffId ? [`- handoff id: ${message.handoffId}`] : []),
    ...(message.replyTo ? [`- reply to: ${message.replyTo}`] : []),
    "",
    message.body ?? "(no body)",
  ].join("\n");
}

export function deliverIncomingProtocolMessage(pi: ExtensionAPI, message: PairMessageV2, triggerTurn: boolean): void {
  pi.sendMessage(
    {
      customType: PAIR_MESSAGE_TYPE,
      content: formatIncomingProtocolMessage(message),
      display: true,
      details: message,
    },
    triggerTurn ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false },
  );
}

function formatClarificationAge(askedAt: string): string {
  const parsed = Date.parse(askedAt);
  if (!Number.isFinite(parsed)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatClarificationLines(
  pending:
    | { handoffId?: string; question: string; askedAt: string; delivery: "live" | "durable"; canReplyNow?: boolean }
    | undefined,
  fallbackReplyAvailability = false,
): string[] {
  if (!pending) {
    return ["- waiting for clarification: no"];
  }

  return [
    "- waiting for clarification: yes",
    ...(pending.handoffId ? [`- clarification handoff id: ${pending.handoffId}`] : []),
    `- clarification delivery: ${pending.delivery}`,
    `- clarification age: ${formatClarificationAge(pending.askedAt)}`,
    `- reply available now: ${(pending.canReplyNow ?? fallbackReplyAvailability) ? "yes" : "no"}`,
    `- clarification question: ${truncate(pending.question, 160)}`,
  ];
}

export function promptForReply(pi: ExtensionAPI, message: PairMessageV2): void {
  const instruction = [
    `${message.from === "builder" ? "Builder needs clarification" : "Planner asked a direct question"}${message.name ? ` (${message.name})` : ""}.`,
    `Reply exactly once with planner_builder({ action: "reply", replyTo: "${message.id}", message: "..." }).`,
    ...(message.handoffId ? [`handoff_id: ${message.handoffId}`] : []),
    "",
    message.body ?? "",
  ].join("\n");
  pi.sendUserMessage(instruction, { deliverAs: "followUp" });
}

export function maybeRelayBuilderEventToUser(pi: ExtensionAPI, message: PairMessageV2): void {
  if (currentPairRole() !== "planner" || message.from !== "builder" || message.type !== "event") return;
  if (!["completed", "failed", "cancelled", "blocker", "clarification_needed"].includes(message.name ?? "")) return;

  let structuredPayloadHandoffId: string | undefined;
  const handoffId = message.handoffId;
  const relayKey = builderRelayDedupKey(message);
  if (relayKey && rt.reportedBuilderEventKeys.has(relayKey)) return;

  const now = Date.now();
  const fingerprint = pairRelayFingerprint(message);
  const withinWindow = (rt.lastBuilderRelayAtMs ?? 0) > now - BUILDER_RELAY_DEDUP_WINDOW_MS;
  if (withinWindow && rt.lastBuilderRelayFingerprint === fingerprint) return;

  rt.lastBuilderRelayFingerprint = fingerprint;
  rt.lastBuilderRelayAtMs = now;
  if (relayKey) rememberReportedBuilderEventKey(relayKey);

  let structuredSummary: string | undefined;
  if (isHighSignalBuilderEvent(message.name ?? "")) {
    try {
      const structuredPayload = parseExecutionUpdatePayload(message.payload, message.name ?? undefined);
      structuredPayloadHandoffId = structuredPayload.handoffId;
      structuredSummary = formatExecutionUpdateRelaySummary(structuredPayload);
    } catch (error) {
      structuredSummary = [
        `Builder sent event '${message.name ?? "event"}' but its structured payload was invalid.`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        message.body ?? "",
      ].filter(Boolean).join("\n");
    }
  }

  const relayPrompt = [
    "Builder sent an execution update.",
    "Reply to the USER now with a concise status update.",
    "Include: (1) status, (2) files changed, (3) validation result, (4) next step.",
    ...(handoffId || structuredPayloadHandoffId ? ["", `handoff_id: ${handoffId ?? structuredPayloadHandoffId}`] : []),
    "",
    structuredSummary ? structuredSummary : [`Builder event (${message.name}):`, message.body ?? ""].join("\n"),
  ].join("\n");

  pi.sendUserMessage(relayPrompt, { deliverAs: "followUp" });
}

export function maybeAutoReportBuilderCompletion(): void {
  if (currentPairRole() !== "builder") return;
  const pending = rt.pendingBuilderHandoff;
  if (!pending?.terminalEventSentAtMs) return;
  rt.pendingBuilderHandoff = undefined;
}

export function formatBuilderStatusReply(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const cwd = getContextCwd(ctx);
  return [
    "Builder status",
    `- cwd: ${cwd}`,
    `- model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
    `- thinking: ${pi.getThinkingLevel()}`,
    ...(rt.pendingBuilderHandoff ? [`- pending handoff id: ${rt.pendingBuilderHandoff.id}`] : []),
    ...(rt.pendingBuilderHandoff?.artifactPath ? [`- pending handoff artifact: ${truncate(rt.pendingBuilderHandoff.artifactPath, 160)}`] : []),
    ...formatClarificationLines(rt.pendingClarification),
  ].join("\n");
}

function formatPassiveBuilderStatusMarkdown(builder: BuilderStatus, note?: string): string {
  const lines = [
    "**builder status**",
    "",
    `- running: ${builder.running ? "yes" : "no"}`,
    `- name: ${builder.agentName}`,
    `- pair id: ${builder.pairId}`,
    `- model: ${builder.model}`,
    `- thinking: ${builder.thinking}`,
    `- tmux session: ${builder.tmuxSession}`,
    `- session file: ${builder.sessionFile}`,
    `- log file: ${builder.logFile}`,
    `- socket path: ${builder.socketPath}`,
    ...formatClarificationLines(builder.pendingClarification, false),
  ];

  if (note) lines.push(`- note: ${note}`);
  if (builder.plannerSessionId) lines.push(`- last planner session id: ${builder.plannerSessionId}`);
  if (builder.plannerSessionFile) lines.push(`- last planner session file: ${builder.plannerSessionFile}`);
  if (builder.startedAt) lines.push(`- started: ${builder.startedAt}`);
  if (builder.lastStoppedAt) lines.push(`- last stopped: ${builder.lastStoppedAt}`);

  if (builder.warnings.length > 0) {
    lines.push("", "**warnings**", "");
    for (const warning of builder.warnings) lines.push(`- ${warning}`);
  }

  if (builder.backlog.length > 0) {
    lines.push("", "**recent builder output**", "", "```text", ...builder.backlog, "```");
  }

  return lines.join("\n");
}

export async function queryBuilderStatusPassive(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ensurePlannerConnection: EnsurePlannerConnection,
  startRpc: StartRpc,
): Promise<string> {
  const cwd = getContextCwd(ctx);
  const { settings } = await refreshSettings(cwd);
  const builder = await getBuilderStatus(pi, cwd, settings, getPlannerSessionBinding(ctx));
  if (!builder.running) {
    return formatPassiveBuilderStatusMarkdown(builder, "builder is not running; direct protocol status unavailable.");
  }

  try {
    const connection = await ensurePlannerConnection(pi, ctx, { autoStart: false });
    const message = createMessage({
      type: "command",
      from: "planner",
      to: "builder",
      pairId: connection.pairId,
      name: "status",
      body: "",
    });
    const reply = await startRpc(message, connection.socket);
    if (!reply.ok) throw new Error(reply.error ?? reply.body ?? "Builder status command failed.");
    return [
      "**builder status**",
      "",
      ...(reply.body ? [reply.body] : [JSON.stringify({ ok: true, reply }, null, 2)]),
    ].join("\n");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return formatPassiveBuilderStatusMarkdown(builder, `passive status only; direct protocol status unavailable: ${err.message}`);
  }
}
