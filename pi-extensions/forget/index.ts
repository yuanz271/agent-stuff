import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { z } from "zod";

const STATE_ENTRY_TYPE = "forget-state";
const MAX_EXCERPT_CHARS = 40_000;

const cleanMessageSchema = z.object({
  role: z.enum(["user", "assistant", "custom"]),
  content: z.string().max(4_000),
  customType: z.string().nullable(),
});

const cleanContextSchema = z.object({
  systemPrompt: z.string().max(12_000),
  retainedSummary: z.string().max(4_000),
  messages: z.array(cleanMessageSchema).max(80),
});

const candidateSchema = z.object({
  label: z.string().max(256),
  reason: z.string().max(512),
});

const atomicRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(["systemPromptChunk", "retainedSummaryChunk", "message"]),
  label: z.string().max(256),
  text: z.string().max(12_000),
  role: z.enum(["user", "assistant", "custom"]).nullable().optional(),
  customType: z.string().nullable().optional(),
});

const decisionSchema = z.object({
  index: z.number().int().nonnegative(),
  action: z.enum(["keep", "remove"]),
  reason: z.string().max(512),
});

const sanitizerResultSchema = z.object({
  status: z.enum(["ok", "ambiguous", "blocked"]),
  decisions: z.array(decisionSchema).max(200).default([]),
  candidates: z.array(candidateSchema).max(20).default([]),
  notes: z.array(z.string().max(512)).max(20).default([]),
});

const forgetSanitizerTool = {
  name: "emit_forget_result",
  description: "Emit per-record /forget sanitizer decisions as a structured tool call",
  parameters: Type.Object({
    status: Type.Union([
      Type.Literal("ok"),
      Type.Literal("ambiguous"),
      Type.Literal("blocked"),
    ]),
    decisions: Type.Array(
      Type.Object({
        index: Type.Number({ minimum: 0 }),
        action: Type.Union([Type.Literal("keep"), Type.Literal("remove")]),
        reason: Type.String({ maxLength: 512 }),
      }, { additionalProperties: false }),
      { maxItems: 200 },
    ),
    candidates: Type.Array(
      Type.Object({
        label: Type.String({ maxLength: 256 }),
        reason: Type.String({ maxLength: 512 }),
      }, { additionalProperties: false }),
      { maxItems: 20 },
    ),
    notes: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 20 }),
  }, { additionalProperties: false }),
} as const;
type CleanMessage = z.infer<typeof cleanMessageSchema>;
type CleanContext = z.infer<typeof cleanContextSchema>;
type AtomicRecord = z.infer<typeof atomicRecordSchema>;
type SanitizerDecision = z.infer<typeof decisionSchema>;
type SanitizerResult = z.infer<typeof sanitizerResultSchema>;

type ForgetStateEntry = {
  active: true;
  sourceQuery: string;
  createdAt: string;
  cleanContext: CleanContext;
};

type ForgetRuntime = {
  activeState: ForgetStateEntry | undefined;
};

const rt: ForgetRuntime = {
  activeState: undefined,
};

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      if (part && typeof part === "object" && "content" in part && typeof (part as { content?: unknown }).content === "string") {
        return (part as { content: string }).content;
      }
      return "";
    })
    .join("\n")
    .trim();
}

function describeEntry(entry: any): string {
  if (!entry || typeof entry !== "object") return "(unrecognized entry)";
  if (entry.type === "message") {
    const msg = entry.message ?? {};
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const customType = typeof msg.customType === "string" ? ` customType=${msg.customType}` : "";
    const toolName = typeof msg.toolName === "string" ? ` tool=${msg.toolName}` : "";
    const text = truncate(extractText(msg.content ?? msg.body ?? ""), 400);
    return `[message role=${role}${customType}${toolName}] ${text}`;
  }
  if (entry.type === "custom") {
    const customType = typeof entry.customType === "string" ? entry.customType : "unknown";
    const data = truncate(JSON.stringify(entry.data ?? {}), 400);
    return `[custom ${customType}] ${data}`;
  }
  const data = truncate(JSON.stringify(entry), 300);
  return `[${String(entry.type ?? "entry")}] ${data}`;
}

function buildSessionExcerpt(ctx: ExtensionContext): string {
  const lines: string[] = [
    `Session id: ${ctx.sessionManager.getSessionId()}`,
    `Session file: ${ctx.sessionManager.getSessionFile()}`,
    `Current system prompt:\n${truncate(ctx.getSystemPrompt(), 4_000)}`,
    "",
    "Recent session entries:",
  ];

  const branch = ctx.sessionManager.getBranch();
  for (const entry of branch) {
    lines.push(`- ${describeEntry(entry)}`);
  }

  const text = lines.join("\n");
  return truncate(text, MAX_EXCERPT_CHARS);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

async function resolveSanitizerModel(ctx: ExtensionContext) {
  if (!ctx.model) {
    throw new Error("forget sanitizer requires an active model.");
  }

  const model = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
  if (!model) {
    throw new Error(`forget sanitizer requires the active model ${ctx.model.provider}/${ctx.model.id} to be present in the local registry.`);
  }

  const registry = ctx.modelRegistry as unknown as Record<string, unknown>;
  if (typeof registry.getApiKeyAndHeaders !== "function") {
    throw new Error("forget sanitizer requires modelRegistry.getApiKeyAndHeaders (unavailable in current runtime).");
  }

  const auth = await (registry.getApiKeyAndHeaders as (m: unknown) => Promise<{ ok?: boolean; apiKey?: string } | undefined>)(model);
  if (!auth?.ok || !auth.apiKey) {
    throw new Error(`forget sanitizer requires API credentials for the active model ${ctx.model.provider}/${ctx.model.id}.`);
  }

  return { model, apiKey: auth.apiKey };
}

function buildSanitizerSystemPrompt(): string {
  return [
    "You are a transient sanitizer session for a Pi /forget workflow.",
    "Your job is to produce a clean successor context artifact that removes stale instructions, rules, facts, summaries, and related derived context.",
    "Preserve code artifacts, file diffs, task outputs, and tool results unless the user explicitly asks to forget them.",
    "Only remove semantic content that plausibly causes future confusion.",
    "Prefer the smallest clean successor context that preserves useful recent work.",
    "Do not modify the main session.",
    "Do not write files.",
    "Do not persist state.",
    "Do not mention /forget unless asked for output format.",
    "Do not explain chain-of-thought.",
    "If the cleanup is ambiguous, return the minimal set of candidate clean contexts with brief labels.",
    "If no safe cleanup exists, say so explicitly.",
    "For status 'ok', include a decision for every provided record.",
    "For status 'ambiguous' or 'blocked', the decisions array may be partial.",
    "You MUST call the emit_forget_result tool and return nothing else.",
  ].join("\n");
}

function splitAtomicText(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function collectBranchMessages(ctx: ExtensionContext): CleanMessage[] {
  const messages: CleanMessage[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry?.type === "message") {
      const msg = entry.message ?? {};
      const role = msg.role;
      if (role !== "user" && role !== "assistant" && role !== "custom") continue;
      const content = extractText(msg.content ?? msg.body ?? "");
      if (!content) continue;
      messages.push({
        role,
        content,
        customType: typeof msg.customType === "string" ? msg.customType : null,
      });
      continue;
    }

    if (entry?.type === "custom") {
      const customType = typeof entry.customType === "string" ? entry.customType : null;
      const content = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? {});
      messages.push({
        role: "custom",
        content,
        customType,
      });
    }
  }
  return messages;
}

function buildSourceContext(ctx: ExtensionContext): CleanContext {
  const active = activeCleanContext(ctx) ?? currentStateFromBranch(ctx)?.cleanContext;
  if (active) return active;
  return {
    systemPrompt: ctx.getSystemPrompt(),
    retainedSummary: "",
    messages: collectBranchMessages(ctx),
  };
}

function buildAtomicRecords(ctx: ExtensionContext): AtomicRecord[] {
  const source = buildSourceContext(ctx);
  const records: AtomicRecord[] = [];
  let index = 0;

  for (const [chunkIndex, chunk] of splitAtomicText(source.systemPrompt).entries()) {
    records.push({
      index: index++,
      kind: "systemPromptChunk",
      label: `systemPrompt[${chunkIndex + 1}]`,
      text: chunk,
    });
  }

  for (const [chunkIndex, chunk] of splitAtomicText(source.retainedSummary).entries()) {
    records.push({
      index: index++,
      kind: "retainedSummaryChunk",
      label: `retainedSummary[${chunkIndex + 1}]`,
      text: chunk,
    });
  }

  for (const [messageIndex, message] of source.messages.entries()) {
    records.push({
      index: index++,
      kind: "message",
      label: `message[${messageIndex + 1}] ${message.role}${message.customType ? `:${message.customType}` : ""}`,
      text: message.content,
      role: message.role,
      customType: message.customType,
    });
  }

  return records;
}

function buildMainPrompt(query: string, records: AtomicRecord[], selectedCandidate?: string): string {
  const payload: Record<string, unknown> = {
    query,
    selectedCandidate: selectedCandidate ?? null,
    records,
  };

  return [
    "You are coordinating a transient sanitizer session for a Pi /forget operation.",
    "Given the ordered atomic records from the current context, decide which records should be kept or removed to produce a clean successor context.",
    "Preserve the original format by construction; do not author the final systemPrompt, retainedSummary, or message array.",
    "Preserve code artifacts, file diffs, task outputs, and tool results unless the user explicitly asks to forget them.",
    "Only remove semantic content that plausibly causes future confusion.",
    "The sanitizer session is isolated, one-shot, and non-persistent.",
    "Do not modify the main session.",
    "Do not write files.",
    "Do not mention or surface the existence of /forget to the model-visible continuation branch.",
    "Return only machine-readable JSON matching the requested schema.",
    "If there is one clear cleaned context, choose it.",
    "If there are multiple plausible clean contexts, return the minimal candidate set.",
    "If no safe cleanup exists, return blocked.",
    "For status 'ok', include a complete decisions array that covers every record.",
    "For status 'ambiguous' or 'blocked', decisions may be partial.",
    "You MUST call the emit_forget_result tool and return nothing else.",
    "Prefer the smallest clean successor context that preserves useful recent work.",
    "Be conservative; fail closed on ambiguity.",
    "Do not include chain-of-thought or hidden reasoning.",
    "",
    "INPUT:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

class SanitizerParseError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
    public readonly selectedCandidate?: string,
  ) {
    super(message);
    this.name = "SanitizerParseError";
  }
}

function parseSanitizerToolCall(response: { content: Array<{ type?: string; name?: string; arguments?: unknown }> }, selectedCandidate?: string): SanitizerResult {
  const toolCall = response.content.find((part) => part.type === "toolCall" && part.name === forgetSanitizerTool.name);
  if (!toolCall || toolCall.type !== "toolCall") {
    throw new SanitizerParseError("sanitizer did not return the required tool call", JSON.stringify(response.content ?? []), selectedCandidate);
  }

  const parsed = sanitizerResultSchema.parse(toolCall.arguments);
  if (parsed.status === "ok" && parsed.decisions.length === 0) {
    throw new SanitizerParseError("sanitizer returned status 'ok' without decisions", JSON.stringify(toolCall.arguments ?? {}), selectedCandidate);
  }
  return parsed;
}

function formatSanitizerFailure(result: SanitizerResult): string {
  const parts = [`status=${result.status}`];
  if (result.candidates.length > 0) {
    parts.push(`candidates=${result.candidates.map((candidate) => candidate.label).join(", ")}`);
  }
  if (result.notes.length > 0) {
    parts.push(`notes=${result.notes.join(" | ")}`);
  }
  if (result.decisions.length > 0) {
    parts.push(`decisions=${result.decisions.slice(0, 8).map((item) => `${item.index}:${item.action}`).join(", ")}${result.decisions.length > 8 ? ", …" : ""}`);
  }
  return parts.join("; ");
}

function currentStateFromBranch(ctx: ExtensionContext): ForgetStateEntry | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    if (entry?.type !== "custom" || entry?.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<ForgetStateEntry> | undefined;
    if (!data?.active || !data.cleanContext) continue;
    if (!Array.isArray(data.cleanContext.messages)) continue;
    return {
      active: true,
      sourceQuery: typeof data.sourceQuery === "string" ? data.sourceQuery : "",
      createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
      cleanContext: {
        systemPrompt: typeof data.cleanContext.systemPrompt === "string" ? data.cleanContext.systemPrompt : "",
        retainedSummary: typeof data.cleanContext.retainedSummary === "string" ? data.cleanContext.retainedSummary : "",
        messages: data.cleanContext.messages.filter((m): m is CleanMessage => {
          return !!m && typeof m === "object"
            && (m.role === "user" || m.role === "assistant" || m.role === "custom")
            && typeof m.content === "string"
            && (m.customType === null || typeof m.customType === "string");
        }),
      },
    };
  }
  return undefined;
}

function activeCleanContext(ctx: ExtensionContext): CleanContext | undefined {
  return rt.activeState?.cleanContext ?? currentStateFromBranch(ctx)?.cleanContext;
}

async function appendForgetState(pi: ExtensionAPI, cleanContext: CleanContext, sourceQuery: string): Promise<void> {
  pi.appendEntry<ForgetStateEntry>(STATE_ENTRY_TYPE, {
    active: true,
    sourceQuery,
    createdAt: new Date().toISOString(),
    cleanContext,
  });
}

async function runSanitizer(pi: ExtensionAPI, ctx: ExtensionContext, query: string, selectedCandidate?: string): Promise<SanitizerResult> {
  const { model, apiKey } = await resolveSanitizerModel(ctx);
  const records = buildAtomicRecords(ctx);
  const response = await complete(
    model,
    {
      systemPrompt: buildSanitizerSystemPrompt(),
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: buildMainPrompt(query, records, selectedCandidate) }],
          timestamp: Date.now(),
        },
      ],
      tools: [forgetSanitizerTool],
    },
    { apiKey },
  );

  return parseSanitizerToolCall(response as any, selectedCandidate);
}

async function chooseCandidate(ctx: ExtensionContext, candidates: SanitizerResult["candidates"]): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  const labels = candidates.map((candidate, index) => `${index + 1}. ${candidate.label} — ${candidate.reason}`);
  const picked = await ctx.ui.select("Multiple clean contexts are plausible. Pick one:", labels);
  if (!picked) return undefined;
  const separator = picked.indexOf(" — ");
  const rawLabel = separator >= 0 ? picked.slice(0, separator) : picked;
  return rawLabel.replace(/^\d+\.\s*/, "");
}

function rebuildCleanContext(records: AtomicRecord[]): CleanContext {
  const systemPromptChunks: string[] = [];
  const summaryChunks: string[] = [];
  const messages: CleanMessage[] = [];

  for (const record of records) {
    if (record.kind === "systemPromptChunk") {
      systemPromptChunks.push(record.text);
      continue;
    }
    if (record.kind === "retainedSummaryChunk") {
      summaryChunks.push(record.text);
      continue;
    }

    messages.push({
      role: record.role ?? "custom",
      content: record.text,
      customType: record.role === "custom" ? (record.customType ?? null) : null,
    });
  }

  return {
    systemPrompt: systemPromptChunks.join("\n\n").trim(),
    retainedSummary: summaryChunks.join("\n\n").trim(),
    messages,
  };
}

async function activateCleanBranch(pi: ExtensionAPI, ctx: ExtensionContext, cleanContext: CleanContext, sourceQuery: string): Promise<boolean> {
  const newSession = (ctx as unknown as {
    newSession?: (options?: { withSession?: (nextCtx: ExtensionContext) => Promise<void> | void }) => Promise<{ cancelled?: boolean }>;
  }).newSession;
  if (typeof newSession !== "function") {
    throw new Error("Pi runtime does not support ctx.newSession(), so /forget cannot safely create a clean branch.");
  }

  const result = await newSession.call(ctx, {
    withSession: async (nextCtx) => {
      await appendForgetState(pi, cleanContext, sourceQuery);
      rt.activeState = {
        active: true,
        sourceQuery,
        createdAt: new Date().toISOString(),
        cleanContext,
      };
      if (nextCtx.hasUI) {
        nextCtx.ui.notify("Created a cleaned session branch.", "info");
      }
    },
  });

  return !result?.cancelled;
}

export default function forgetExtension(pi: ExtensionAPI) {
  const updateRuntimeFromContext = (ctx: ExtensionContext) => {
    rt.activeState = currentStateFromBranch(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    updateRuntimeFromContext(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateRuntimeFromContext(ctx);
  });

  pi.on("context", async (event, ctx) => {
    const cleanContext = activeCleanContext(ctx);
    if (!cleanContext) return;
    return {
      messages: [
        ...cleanContext.messages,
        ...event.messages,
      ],
    };
  });

  pi.on("before_agent_start", async () => {
    if (!rt.activeState) return;
    return {
      systemPrompt: rt.activeState.cleanContext.systemPrompt,
    };
  });

  pi.registerCommand("forget", {
    description: "Create a clean branch by transiently sanitizing stale semantic context: /forget <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /forget <query>", "error");
        return;
      }

      try {
        const initial = await runSanitizer(pi, ctx, query);
        let result = initial;

        if (result.status === "ambiguous") {
          const selection = await chooseCandidate(ctx, result.candidates);
          if (!selection) {
            ctx.ui.notify("No candidate selected.", "warning");
            return;
          }
          result = await runSanitizer(pi, ctx, query, selection);
        }

        if (result.status !== "ok") {
          ctx.ui.notify(`No clean successor context could be produced: ${formatSanitizerFailure(result)}`, "error");
          return;
        }

        const decisions = new Map(result.decisions.map((decision) => [decision.index, decision] as const));
        const records = buildAtomicRecords(ctx);
        const keepRecords = records.filter((record) => {
          const decision = decisions.get(record.index);
          if (!decision) {
            throw new SanitizerParseError(`sanitizer omitted decision for record ${record.index} (${record.label})`, JSON.stringify(result), query);
          }
          return decision.action === "keep";
        });

        const cleanContext = rebuildCleanContext(keepRecords);
        if (!cleanContext.systemPrompt.trim()) {
          throw new SanitizerParseError("sanitizer reconstruction produced an empty system prompt", JSON.stringify(result), query);
        }
        const activated = await activateCleanBranch(pi, ctx, cleanContext, query);
        if (!activated) return;
      } catch (error) {
        if (error instanceof SanitizerParseError) {
          ctx.ui.notify(`forget failed: ${error.message}`, "error");
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`forget failed: ${message}`, "error");
      }
    },
  });
}
