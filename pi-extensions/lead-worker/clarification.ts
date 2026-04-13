import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ExecutionUpdatePayload } from "./execution-updates.js";
import type { PairMessageV2 } from "./protocol.js";
import {
  clearWorkerPendingClarification,
  getWorkerStatus,
  setWorkerPendingClarification,
  type PendingClarificationSnapshot,
  type WorkerStatus,
} from "./utils.js";
import {
  MAX_CONTEXT_MESSAGE_CHARS,
  rt,
  currentPairRole,
  getContextCwd,
  getLeadSessionBinding,
  refreshSettings,
  truncate,
  type PendingClarification,
} from "./runtime.js";

async function settingsForContext(ctx: ExtensionContext) {
  return rt.currentSettings?.settings ?? (await refreshSettings(getContextCwd(ctx))).settings;
}

export function clarificationStateFromExecutionUpdate(
  payload: ExecutionUpdatePayload,
  delivery: PendingClarification["delivery"],
  canReplyNow: boolean,
  replyTo?: string,
): PendingClarification {
  if (payload.status !== "clarification_needed") {
    throw new Error(`clarification state requires clarification_needed payload, got '${payload.status}'`);
  }
  return {
    ...pendingClarificationSnapshot(payload.question ?? payload.summary, new Date().toISOString(), delivery, payload.handoffId),
    ...(replyTo ? { replyTo } : {}),
    canReplyNow,
  };
}

export function pendingClarificationSnapshot(
  question: string,
  askedAt: string,
  delivery: PendingClarification["delivery"],
  handoffId?: string,
): PendingClarificationSnapshot {
  const normalizedQuestion = truncate(question.trim() || "(no clarification text provided)", MAX_CONTEXT_MESSAGE_CHARS);
  return {
    ...(handoffId ? { handoffId } : {}),
    question: normalizedQuestion,
    askedAt: askedAt.trim() || new Date().toISOString(),
    delivery,
  };
}

export function pendingClarificationFromMessage(
  message: Pick<PairMessageV2, "body" | "timestamp" | "handoffId">,
  delivery: PendingClarification["delivery"],
  canReplyNow: boolean,
  replyTo?: string,
): PendingClarification {
  return {
    ...pendingClarificationSnapshot(message.body ?? "", message.timestamp ?? new Date().toISOString(), delivery, message.handoffId),
    ...(replyTo ? { replyTo } : {}),
    canReplyNow,
  };
}

export async function rememberPendingClarification(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  clarification: PendingClarification,
): Promise<void> {
  rt.pendingClarification = clarification;
  if (currentPairRole() !== "worker") return;
  const settings = await settingsForContext(ctx);
  const { handoffId, question, askedAt, delivery } = clarification;
  await setWorkerPendingClarification(pi, getContextCwd(ctx), settings, {
    ...(handoffId ? { handoffId } : {}),
    question,
    askedAt,
    delivery,
  });
}

export async function clearPendingClarification(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  rt.pendingClarification = undefined;
  if (currentPairRole() !== "worker") return;
  const settings = await settingsForContext(ctx);
  await clearWorkerPendingClarification(pi, getContextCwd(ctx), settings);
}

function restorePendingClarificationFromStatus(worker: WorkerStatus): void {
  rt.pendingClarification = worker.pendingClarification
    ? { ...worker.pendingClarification, canReplyNow: false }
    : undefined;
}

export async function restorePendingClarificationState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (rt.pendingClarification) return;
  const cwd = getContextCwd(ctx);
  const { settings } = rt.currentSettings ?? await refreshSettings(cwd);
  const worker = await getWorkerStatus(pi, cwd, settings, getLeadSessionBinding(ctx));
  restorePendingClarificationFromStatus(worker);
}
