import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const STATE_ENTRY_TYPE = "forget-state";
const MAX_EXCERPT_CHARS = 40_000;

const cleanMessageSchema = z.object({
  role: z.enum(["user", "assistant", "custom"]),
  content: z.string(),
  customType: z.string().nullable(),
});

const cleanContextSchema = z.object({
  systemPrompt: z.string(),
  retainedSummary: z.string(),
  messages: z.array(cleanMessageSchema),
});

const removedItemSchema = z.object({
  kind: z.enum(["instruction", "rule", "fact", "summary", "custom"]),
  label: z.string(),
  reason: z.string(),
});

const candidateSchema = z.object({
  label: z.string(),
  reason: z.string(),
});

const sanitizerResultSchema = z.object({
  status: z.enum(["ok", "ambiguous", "blocked"]),
  cleanContext: cleanContextSchema.nullable(),
  removed: z.array(removedItemSchema).default([]),
  candidates: z.array(candidateSchema).default([]),
  notes: z.array(z.string()).default([]),
});

type CleanMessage = z.infer<typeof cleanMessageSchema>;
type CleanContext = z.infer<typeof cleanContextSchema>;
type SanitizerResult = z.infer<typeof sanitizerResultSchema>;

type ForgetStateEntry = {
  active: true;
  sourceQuery: string;
  createdAt: string;
  cleanContext: CleanContext;
};

type PendingForgetSeed = {
  sourceQuery: string;
  cleanContext: CleanContext;
  createdAt: string;
};

type ForgetRuntime = {
  activeState: ForgetStateEntry | undefined;
  pendingSeed: PendingForgetSeed | undefined;
};

const rt: ForgetRuntime = {
  activeState: undefined,
  pendingSeed: undefined,
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
  const start = Math.max(0, branch.length - 80);
  for (const entry of branch.slice(start)) {
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
    "Prefer the smallest clean successor context that preserves useful recent work.",
    "Do not modify the main session.",
    "Do not write files.",
    "Do not persist state.",
    "Do not mention /forget unless asked for output format.",
    "Do not explain chain-of-thought.",
    "If the cleanup is ambiguous, return the minimal set of candidate clean contexts with brief labels.",
    "If no safe cleanup exists, say so explicitly.",
    "Return only machine-readable JSON matching the requested schema.",
  ].join("\n");
}

function buildMainPrompt(query: string, excerpt: string, selectedCandidate?: string): string {
  const payload: Record<string, unknown> = {
    query,
    selectedCandidate: selectedCandidate ?? null,
    currentSession: excerpt,
  };

  return [
    "You are coordinating a transient sanitizer session for a Pi /forget operation.",
    "Given the provided session-tree excerpt and fuzzy user query, determine the safest semantic redaction needed to produce a clean successor context artifact.",
    "The sanitizer session is isolated, one-shot, and non-persistent.",
    "Do not modify the main session.",
    "Do not write files.",
    "Do not mention or surface the existence of /forget to the model-visible continuation branch.",
    "Return only machine-readable JSON matching the requested schema.",
    "If there is one clear cleaned context, choose it.",
    "If there are multiple plausible clean contexts, return the minimal candidate set.",
    "If no safe cleanup exists, return blocked.",
    "Prefer the smallest clean successor context that preserves useful recent work.",
    "Be conservative; fail closed on ambiguity.",
    "Do not include chain-of-thought or hidden reasoning.",
    "",
    "INPUT:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function parseSanitizerResult(text: string): SanitizerResult {
  const json = extractJson(text);
  return sanitizerResultSchema.parse(JSON.parse(json));
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
  const response = await complete(
    model,
    {
      systemPrompt: buildSanitizerSystemPrompt(),
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: buildMainPrompt(query, buildSessionExcerpt(ctx), selectedCandidate) }],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    },
    { apiKey },
  );

  const text = response.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("")
    .trim();
  if (!text) throw new Error("forget sanitizer returned an empty response.");
  return parseSanitizerResult(text);
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

async function activateCleanBranch(pi: ExtensionAPI, ctx: ExtensionContext, cleanContext: CleanContext, sourceQuery: string): Promise<boolean> {
  rt.pendingSeed = {
    sourceQuery,
    cleanContext,
    createdAt: new Date().toISOString(),
  };

  const newSession = (ctx as unknown as { newSession?: () => Promise<{ cancelled?: boolean }> }).newSession;
  if (typeof newSession !== "function") {
    throw new Error("Pi runtime does not support ctx.newSession(), so /forget cannot safely create a clean branch.");
  }

  try {
    const result = await newSession.call(ctx);
    if (result?.cancelled) {
      rt.pendingSeed = undefined;
      return false;
    }
    return true;
  } catch (error) {
    rt.pendingSeed = undefined;
    throw error;
  }
}

export default function forgetExtension(pi: ExtensionAPI) {
  const updateRuntimeFromContext = (ctx: ExtensionContext) => {
    rt.activeState = currentStateFromBranch(ctx);
  };

  pi.on("session_start", async (event, ctx) => {
    updateRuntimeFromContext(ctx);

    if (!rt.pendingSeed) return;
    if (event.reason !== "new" && event.reason !== "fork" && event.reason !== "resume" && event.reason !== "startup") return;

    try {
      await appendForgetState(pi, rt.pendingSeed.cleanContext, rt.pendingSeed.sourceQuery);
      rt.activeState = {
        active: true,
        sourceQuery: rt.pendingSeed.sourceQuery,
        createdAt: rt.pendingSeed.createdAt,
        cleanContext: rt.pendingSeed.cleanContext,
      };
      if (ctx.hasUI) {
        ctx.ui.notify("Created a cleaned session branch.", "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) {
        ctx.ui.notify(`forget branch activation failed: ${message}`, "error");
      }
    } finally {
      rt.pendingSeed = undefined;
    }
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

        if (result.status !== "ok" || !result.cleanContext) {
          ctx.ui.notify("No clean successor context could be produced.", "error");
          return;
        }

        const activated = await activateCleanBranch(pi, ctx, result.cleanContext, query);
        if (!activated) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`forget failed: ${message}`, "error");
      }
    },
  });
}
