import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete, getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { PairMessageV2 } from "./protocol.js";
import {
  MAX_PENDING_SUPERVISION_EVENTS,
  MAX_SUPERVISED_RECENT_EVENTS,
  MAX_SUPERVISED_STEERS,
  SUPERVISOR_MODEL_ID,
  SUPERVISOR_MODEL_PROVIDER,
  type ActiveSupervisedHandoff,
  type SupervisorDecision,
  currentPairRole,
  isTerminalSupervisionEvent,
  rt,
  truncate,
} from "./runtime.js";

export type SendOneWayEvent = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: { name: string; body: string; handoffId?: string; autoStart: boolean; failIfUnavailable: boolean },
) => Promise<unknown>;

const SUPERVISOR_DECISION_TOOL = {
  name: "report_supervisor_decision",
  description: "Report the supervisor decision for the current worker execution state",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("continue"),
      Type.Literal("steer"),
      Type.Literal("done"),
      Type.Literal("escalate"),
    ], { description: "continue: worker is on track; steer: inject a correction; done: goal is met; escalate: surface to human" }),
    message: Type.Optional(Type.String({ description: "Required for steer and escalate: the message to inject or surface" })),
    confidence: Type.Number({ description: "Confidence in this decision, 0.0-1.0" }),
    reasoning: Type.String({ description: "Brief reasoning" }),
  }),
};

export async function synthesizeOutcome(
  handoffSpec: string,
  apiKey: string,
): Promise<string> {
  const model = getModel(SUPERVISOR_MODEL_PROVIDER, SUPERVISOR_MODEL_ID);
  if (!model) return truncate(handoffSpec, 500);

  try {
    const response = await complete(
      model,
      {
        systemPrompt: "Summarize the following task handoff as a single concise sentence describing what successful completion looks like. Output only the sentence, no preamble.",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: handoffSpec }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      },
      { apiKey },
    );
    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text ?? ""))
      .join("")
      .trim();
    return text || truncate(handoffSpec, 500);
  } catch (error) {
    console.warn("[lead-worker] synthesizeOutcome failed:", error instanceof Error ? error.message : String(error));
    return truncate(handoffSpec, 500);
  }
}

export function isMeaningfulSupervisionEvent(eventName: string): boolean {
  return ["progress", "blocker", "clarification_needed", "completed", "failed", "cancelled"].includes(eventName);
}

function pendingClarificationForHandoff(supervised: ActiveSupervisedHandoff) {
  const pending = rt.pendingClarification;
  if (!pending) return undefined;
  if (pending.handoffId && pending.handoffId !== supervised.id) return undefined;
  return pending;
}

function formatPendingClarificationForSupervisor(supervised: ActiveSupervisedHandoff): string {
  const pending = pendingClarificationForHandoff(supervised);
  if (!pending) return "Pending clarification: none";
  return [
    "Pending clarification: yes",
    ...(pending.handoffId ? [`Handoff id: ${pending.handoffId}`] : []),
    `Delivery: ${pending.delivery}`,
    `Reply available now: ${pending.canReplyNow ? "yes" : "no"}`,
    `Question: ${pending.question}`,
  ].join("\n");
}

function queuedTerminalIndex(events: PairMessageV2[]): number {
  return events.findIndex((queued) => isTerminalSupervisionEvent(queued.name ?? ""));
}

function hasQueuedTerminal(events: PairMessageV2[]): boolean {
  return queuedTerminalIndex(events) >= 0;
}

function trimRecentSupervisionEvents(supervised: ActiveSupervisedHandoff): void {
  if (supervised.recentEvents.length > MAX_SUPERVISED_RECENT_EVENTS * 2) {
    supervised.recentEvents = supervised.recentEvents.slice(-MAX_SUPERVISED_RECENT_EVENTS);
  }
}

function upsertQueuedEvent(supervised: ActiveSupervisedHandoff, event: PairMessageV2, beforeTerminal: boolean): void {
  const eventName = event.name ?? "";
  const existingIndex = supervised.pendingEvents.findIndex((queued) => (queued.name ?? "") === eventName);
  if (existingIndex >= 0) {
    supervised.pendingEvents.splice(existingIndex, 1);
  }

  if (!beforeTerminal) {
    supervised.pendingEvents.push(event);
    return;
  }

  const terminalIndex = queuedTerminalIndex(supervised.pendingEvents);
  if (terminalIndex < 0) {
    throw new Error("Lead supervision queue entered an invalid terminal state.");
  }
  supervised.pendingEvents.splice(terminalIndex, 0, event);
}

function enqueueSupervisionEvent(supervised: ActiveSupervisedHandoff, event: PairMessageV2): void {
  const eventName = event.name ?? "";
  const terminalQueued = hasQueuedTerminal(supervised.pendingEvents);

  if (isTerminalSupervisionEvent(eventName)) {
    supervised.pendingEvents = supervised.pendingEvents.filter((queued) => {
      const queuedName = queued.name ?? "";
      return queuedName !== "progress" && !isTerminalSupervisionEvent(queuedName);
    });
    upsertQueuedEvent(supervised, event, false);
  } else if (terminalQueued) {
    if (eventName !== "progress") {
      upsertQueuedEvent(supervised, event, true);
    }
  } else {
    upsertQueuedEvent(supervised, event, false);
  }

  if (supervised.pendingEvents.length > MAX_PENDING_SUPERVISION_EVENTS) {
    throw new Error(`Lead supervision queue exceeded bound of ${MAX_PENDING_SUPERVISION_EVENTS} events.`);
  }
}

export async function resolveLeadSupervisionModel(ctx: ExtensionContext): Promise<{ model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>; apiKey: string }> {
  const provider = rt.lastObservedLeadModel.provider ?? ctx.model?.provider;
  const modelId = rt.lastObservedLeadModel.modelId ?? ctx.model?.id;
  if (!provider || !modelId) {
    throw new Error("Lead supervision requires an active lead model, but none is currently selected.");
  }

  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Lead supervision requires the active lead model ${provider}/${modelId} to be present in the local registry.`);
  }

  const registry = ctx.modelRegistry as unknown as Record<string, unknown>;
  if (typeof registry.getApiKeyAndHeaders !== "function") {
    throw new Error("Lead supervision requires modelRegistry.getApiKeyAndHeaders (unavailable in current runtime).");
  }
  const auth = await (registry.getApiKeyAndHeaders as (m: unknown) => Promise<{ ok?: boolean; apiKey?: string }>)(model);
  if (!auth?.ok || !auth.apiKey) {
    throw new Error(`Lead supervision requires API credentials for the active lead model ${provider}/${modelId}.`);
  }

  return { model, apiKey: auth.apiKey };
}

async function analyzeWorkerEvent(
  model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>,
  supervised: ActiveSupervisedHandoff,
  apiKey: string,
): Promise<SupervisorDecision> {
  const stagnating = supervised.steerCount >= MAX_SUPERVISED_STEERS;
  const pendingClarification = pendingClarificationForHandoff(supervised);
  const recentEventText = supervised.recentEvents
    .slice(-MAX_SUPERVISED_RECENT_EVENTS)
    .map((e) => `[${e.name ?? e.type}] ${e.body ?? ""}`)
    .join("\n");

  const response = await complete(
    model,
    {
      systemPrompt: [
        "You are the lead-side supervisor for a lead-worker coding session.",
        "Analyze the worker's progress against the stated outcome and decide what to do.",
        pendingClarification
          ? "The worker is explicitly waiting for clarification from the lead. While clarification is pending, prefer continue rather than steer or escalate unless there is clear evidence the task is irrecoverably off track."
          : "",
        stagnating ? `The worker has been steered ${supervised.steerCount} times without completing. Lean toward escalate.` : "",
        "You MUST call the report_supervisor_decision tool.",
      ].filter(Boolean).join(" "),
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: [
                `Outcome: ${supervised.outcome}`,
                "",
                "Handoff spec:",
                supervised.spec,
                "",
                formatPendingClarificationForSupervisor(supervised),
                "",
                "Recent worker events:",
                recentEventText || "(none yet)",
              ].join("\n"),
            },
          ],
          timestamp: Date.now(),
        },
      ],
      tools: [SUPERVISOR_DECISION_TOOL],
    },
    { apiKey },
  );

  const toolCall = response.content.find((c: any) => c.type === "toolCall" && c.name === SUPERVISOR_DECISION_TOOL.name);
  if (!toolCall || toolCall.type !== "toolCall") {
    throw new Error("Lead supervision analysis did not return a report_supervisor_decision tool call.");
  }
  const args = toolCall.arguments as Record<string, unknown>;
  return {
    action: (args.action as SupervisorDecision["action"]) ?? "continue",
    message: typeof args.message === "string" ? args.message : undefined,
    confidence: typeof args.confidence === "number" ? args.confidence : 0,
    reasoning: typeof args.reasoning === "string" ? args.reasoning : "",
  };
}

async function processLeadSupervisionEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  supervised: ActiveSupervisedHandoff,
  event: PairMessageV2,
  sendOneWayEvent: SendOneWayEvent,
): Promise<void> {
  supervised.recentEvents.push(event);
  trimRecentSupervisionEvents(supervised);

  const eventName = event.name ?? "";
  const isTerminal = isTerminalSupervisionEvent(eventName);
  if (!isTerminal && hasQueuedTerminal(supervised.pendingEvents)) {
    return;
  }

  if (!isTerminal && pendingClarificationForHandoff(supervised)) {
    return;
  }

  const { model, apiKey } = await resolveLeadSupervisionModel(ctx);

  let decision: SupervisorDecision;
  if (isTerminal) {
    decision = await analyzeWorkerEvent(model, supervised, apiKey);
    if (decision.action === "steer") {
      decision = { action: "escalate", confidence: decision.confidence, reasoning: `terminal event with steer suggestion converted to escalate: ${decision.reasoning}` };
    }
    rt.activeSupervisedHandoff = undefined;
  } else if (supervised.steerCount >= MAX_SUPERVISED_STEERS) {
    decision = { action: "escalate", confidence: 1, reasoning: "stagnation threshold reached" };
    rt.activeSupervisedHandoff = undefined;
  } else {
    decision = await analyzeWorkerEvent(model, supervised, apiKey);
  }

  if (decision.action === "continue") return;

  if (decision.action === "steer" && decision.message) {
    supervised.steerCount++;
    try {
      await sendOneWayEvent(pi, ctx, {
        name: "steer",
        body: decision.message,
        handoffId: supervised.id,
        autoStart: false,
        failIfUnavailable: false,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Lead supervision failed to deliver steer message: ${err.message}`);
    }
    return;
  }

  if (decision.action === "done") {
    ctx.hasUI && ctx.ui.notify(`Lead-worker supervision: outcome achieved for handoff ${supervised.id.slice(0, 8)}.`, "info");
    rt.activeSupervisedHandoff = undefined;
    return;
  }

  if (decision.action === "escalate") {
    const summary = [
      `Lead-worker supervision escalating handoff ${supervised.id.slice(0, 8)} — needs your attention.`,
      `Outcome: ${supervised.outcome}`,
      `Steer count: ${supervised.steerCount}`,
      decision.message ? `Reason: ${decision.message}` : `Reason: ${decision.reasoning}`,
    ].join(" | ");
    ctx.hasUI && ctx.ui.notify(summary, "warning");
    pi.sendUserMessage(
      [
        "[LEAD-WORKER SUPERVISION ESCALATION]",
        `handoff_id: ${supervised.id}`,
        `outcome: ${supervised.outcome}`,
        `steer_count: ${supervised.steerCount}`,
        `reason: ${decision.message ?? decision.reasoning}`,
        "",
        "Review the latest worker events and decide the next action.",
      ].join("\n"),
      { deliverAs: "followUp" },
    );
    rt.activeSupervisedHandoff = undefined;
  }
}

export async function maybeRunLeadSupervision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: PairMessageV2,
  sendOneWayEvent: SendOneWayEvent,
): Promise<void> {
  if (currentPairRole() !== "lead") return;
  const supervised = rt.activeSupervisedHandoff;
  if (!supervised) return;
  if (event.handoffId && event.handoffId !== supervised.id) return;

  const eventName = event.name ?? "";
  if (!isMeaningfulSupervisionEvent(eventName)) return;

  enqueueSupervisionEvent(supervised, event);
  if (supervised.supervisionRunning) return;
  supervised.supervisionRunning = true;

  try {
    while (rt.activeSupervisedHandoff === supervised && supervised.pendingEvents.length > 0) {
      const nextEvent = supervised.pendingEvents.shift();
      if (!nextEvent) continue;
      await processLeadSupervisionEvent(pi, ctx, supervised, nextEvent, sendOneWayEvent);
    }
  } catch (error) {
    if (rt.activeSupervisedHandoff === supervised) {
      rt.activeSupervisedHandoff = undefined;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Lead supervision failed for handoff ${supervised.id}: ${err.message}`);
  } finally {
    if (rt.activeSupervisedHandoff === supervised) {
      supervised.supervisionRunning = false;
    }
  }
}
