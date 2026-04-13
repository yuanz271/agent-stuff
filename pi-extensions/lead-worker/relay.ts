import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createMessage, type PairMessageV2 } from "./protocol.js";
import {
  getWorkerStatus,
  type WorkerStatus,
} from "./utils.js";
import {
  MAX_TRACKED_REPORTED_HANDOFF_IDS,
  PAIR_MESSAGE_TYPE,
  WORKER_RELAY_DEDUP_WINDOW_MS,
  type ActiveConnection,
  type PendingWorkerHandoff,
  rt,
  currentPairRole,
  getLeadSessionBinding,
  isTerminalSupervisionEvent,
  refreshSettings,
  truncate,
} from "./runtime.js";

export type EnsureLeadConnection = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { autoStart: boolean; failIfUnavailable: boolean },
) => Promise<ActiveConnection>;

export type StartRpc = (message: PairMessageV2, socket: ActiveConnection["socket"]) => Promise<PairMessageV2>;

function normalizeWhitespaceLower(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function pairRelayFingerprint(message: PairMessageV2): string {
  const handoffId = message.handoffId ?? "";
  return `${message.from}|${message.to}|${message.type}|${message.name ?? ""}|${message.pairId}|${handoffId}|${normalizeWhitespaceLower(message.body ?? "")}`;
}

export function inferWorkerEventName(text: string, pendingHandoff: PendingWorkerHandoff | undefined): string {
  const normalized = normalizeWhitespaceLower(text);
  if (/\bstatus\s*:\s*(done|completed)\b/.test(normalized)) return "completed";
  if (/\bstatus\s*:\s*(failed|cancelled)\b/.test(normalized)) return "failed";
  if (/\bstatus\s*:\s*blocked\b/.test(normalized)) return "blocker";
  if (/\bclarification\b/.test(normalized)) return "clarification_needed";
  return pendingHandoff ? "progress" : "message";
}

function workerRelayDedupKey(message: PairMessageV2): string | undefined {
  const handoffId = message.handoffId?.trim();
  const eventName = message.name ?? "event";
  if (!handoffId || !isTerminalSupervisionEvent(eventName)) return undefined;
  return `${handoffId}:terminal`;
}

function rememberReportedWorkerEventKey(key: string): void {
  rt.reportedWorkerEventKeys.add(key);
  if (rt.reportedWorkerEventKeys.size <= MAX_TRACKED_REPORTED_HANDOFF_IDS) return;
  const oldest = rt.reportedWorkerEventKeys.values().next().value;
  if (oldest) rt.reportedWorkerEventKeys.delete(oldest);
}

function formatIncomingProtocolMessage(message: PairMessageV2): string {
  const heading = message.type === "event"
    ? `**lead-worker event from ${message.from}: ${message.name ?? "event"}**`
    : message.type === "request"
      ? `**lead-worker request from ${message.from}${message.name ? `: ${message.name}` : ""}**`
      : `**lead-worker message from ${message.from}**`;
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
    `${message.from === "worker" ? "Worker needs clarification" : "Lead asked a direct question"}${message.name ? ` (${message.name})` : ""}.`,
    `Reply exactly once with lead_worker({ action: "reply", replyTo: "${message.id}", message: "..." }).`,
    ...(message.handoffId ? [`handoff_id: ${message.handoffId}`] : []),
    "",
    message.body ?? "",
  ].join("\n");
  pi.sendUserMessage(instruction, { deliverAs: "followUp" });
}

export function maybeRelayWorkerEventToUser(pi: ExtensionAPI, message: PairMessageV2): void {
  if (currentPairRole() !== "lead" || message.from !== "worker" || message.type !== "event") return;
  if (!["completed", "failed", "cancelled", "blocker", "clarification_needed"].includes(message.name ?? "")) return;

  const handoffId = message.handoffId;
  const relayKey = workerRelayDedupKey(message);
  if (relayKey && rt.reportedWorkerEventKeys.has(relayKey)) return;

  const now = Date.now();
  const fingerprint = pairRelayFingerprint(message);
  const withinWindow = (rt.lastWorkerRelayAtMs ?? 0) > now - WORKER_RELAY_DEDUP_WINDOW_MS;
  if (withinWindow && rt.lastWorkerRelayFingerprint === fingerprint) return;

  rt.lastWorkerRelayFingerprint = fingerprint;
  rt.lastWorkerRelayAtMs = now;
  if (relayKey) rememberReportedWorkerEventKey(relayKey);

  const relayPrompt = [
    "Worker sent an execution update.",
    "Reply to the USER now with a concise status update.",
    "Include: (1) status, (2) files changed, (3) validation result, (4) next step.",
    ...(handoffId ? ["", `handoff_id: ${handoffId}`] : []),
    "",
    `Worker event (${message.name}):`,
    message.body ?? "",
  ].join("\n");

  pi.sendUserMessage(relayPrompt, { deliverAs: "followUp" });
}

export function maybeAutoReportWorkerCompletion(): void {
  if (currentPairRole() !== "worker") return;
  const pending = rt.pendingWorkerHandoff;
  if (!pending?.terminalEventSentAtMs) return;
  rt.pendingWorkerHandoff = undefined;
}

export function formatWorkerStatusReply(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const cwd = ctx.cwd ?? process.cwd();
  return [
    "Worker status",
    `- cwd: ${cwd}`,
    `- model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
    `- thinking: ${pi.getThinkingLevel()}`,
    ...(rt.pendingWorkerHandoff ? [`- pending handoff id: ${rt.pendingWorkerHandoff.id}`] : []),
    ...formatClarificationLines(rt.pendingClarification),
  ].join("\n");
}

function formatPassiveWorkerStatusMarkdown(worker: WorkerStatus, note?: string): string {
  const lines = [
    "**worker status**",
    "",
    `- running: ${worker.running ? "yes" : "no"}`,
    `- name: ${worker.agentName}`,
    `- pair id: ${worker.pairId}`,
    `- model: ${worker.model}`,
    `- thinking: ${worker.thinking}`,
    `- tmux session: ${worker.tmuxSession}`,
    `- session file: ${worker.sessionFile}`,
    `- log file: ${worker.logFile}`,
    `- socket path: ${worker.socketPath}`,
    ...formatClarificationLines(worker.pendingClarification, false),
  ];

  if (note) lines.push(`- note: ${note}`);
  if (worker.leadSessionId) lines.push(`- last lead session id: ${worker.leadSessionId}`);
  if (worker.leadSessionFile) lines.push(`- last lead session file: ${worker.leadSessionFile}`);
  if (worker.startedAt) lines.push(`- started: ${worker.startedAt}`);
  if (worker.lastStoppedAt) lines.push(`- last stopped: ${worker.lastStoppedAt}`);

  if (worker.warnings.length > 0) {
    lines.push("", "**warnings**", "");
    for (const warning of worker.warnings) lines.push(`- ${warning}`);
  }

  if (worker.backlog.length > 0) {
    lines.push("", "**recent worker output**", "", "```text", ...worker.backlog, "```");
  }

  return lines.join("\n");
}

export async function queryWorkerStatusPassive(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ensureLeadConnection: EnsureLeadConnection,
  startRpc: StartRpc,
): Promise<string> {
  const cwd = ctx.cwd ?? process.cwd();
  const { settings } = await refreshSettings(cwd);
  const worker = await getWorkerStatus(pi, cwd, settings, getLeadSessionBinding(ctx));
  if (!worker.running) {
    return formatPassiveWorkerStatusMarkdown(worker, "worker is not running; direct protocol status unavailable.");
  }

  try {
    const connection = await ensureLeadConnection(pi, ctx, { autoStart: false, failIfUnavailable: false });
    const message = createMessage({
      type: "command",
      from: "lead",
      to: "worker",
      pairId: connection.pairId,
      name: "status",
      body: "",
    });
    const reply = await startRpc(message, connection.socket);
    if (!reply.ok) throw new Error(reply.error ?? reply.body ?? "Worker status command failed.");
    return [
      "**worker status**",
      "",
      ...(reply.body ? [reply.body] : [JSON.stringify({ ok: true, reply }, null, 2)]),
    ].join("\n");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return formatPassiveWorkerStatusMarkdown(worker, `passive status only; direct protocol status unavailable: ${err.message}`);
  }
}
