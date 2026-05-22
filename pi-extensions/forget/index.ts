import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "forget-state";

export type CleanMessage = {
  role: "user" | "assistant" | "custom";
  content: string;
  customType: string | null;
};

type CleanContext = {
  systemPrompt: string;
  retainedSummary: string;
  messages: CleanMessage[];
};

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

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
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

function collectBranchMessages(ctx: ExtensionContext): CleanMessage[] {
  // Safe sweep rule: only SessionEntry.type === "message" entries with user/assistant roles are candidates.
  // Everything else (custom_message, branch_summary, compaction, custom state, etc.) is preserved untouched.
  const messages: CleanMessage[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry?.type === "message") {
      const msg = entry.message ?? {};
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const content = extractText(msg.content ?? msg.body ?? "");
      if (!content) continue;
      messages.push({
        role: msg.role as CleanMessage["role"],
        content,
        customType: null,
      });
      continue;
    }

    if (entry?.type === "custom_message") {
      const content = extractText(entry.content ?? "");
      if (!content) continue;
      messages.push({ role: "custom", content, customType: typeof entry.customType === "string" ? entry.customType : null });
      continue;
    }

    if (entry?.type === "branch_summary") {
      if (typeof entry.summary !== "string" || !entry.summary.trim()) continue;
      messages.push({ role: "custom", content: entry.summary, customType: "branch_summary" });
      continue;
    }

    if (entry?.type === "compaction") {
      if (typeof entry.summary !== "string" || !entry.summary.trim()) continue;
      messages.push({ role: "custom", content: entry.summary, customType: "compaction" });
    }
  }
  return messages;
}

function currentStateFromBranch(ctx: ExtensionContext): ForgetStateEntry | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    if (entry?.type !== "custom" || entry?.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<ForgetStateEntry> | undefined;
    if (!data?.active || !data.cleanContext) continue;
    if (typeof data.cleanContext.systemPrompt !== "string") continue;
    if (typeof data.cleanContext.retainedSummary !== "string") continue;
    if (!Array.isArray(data.cleanContext.messages)) continue;

    return {
      active: true,
      sourceQuery: typeof data.sourceQuery === "string" ? data.sourceQuery : "",
      createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
      cleanContext: {
        systemPrompt: data.cleanContext.systemPrompt,
        retainedSummary: data.cleanContext.retainedSummary,
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

function buildSourceContext(ctx: ExtensionContext): CleanContext {
  const active = activeCleanContext(ctx);
  if (active) return active;
  return {
    systemPrompt: ctx.getSystemPrompt(),
    retainedSummary: "",
    messages: collectBranchMessages(ctx),
  };
}

async function resolveSanitizerModel(ctx: ExtensionContext): Promise<{ model: any; apiKey: string }> {
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

const SANITIZER_SYSTEM_PROMPT =
  "You are a transient text sanitizer for a Pi /forget workflow. Clean only the raw message text provided by the user. Return only the cleaned text. Leave the system prompt untouched.";

async function sanitizeMessageText(
  model: any,
  apiKey: string,
  query: string,
  role: "user" | "assistant",
  text: string,
): Promise<string> {
  const response = await complete(
    model,
    {
      systemPrompt: SANITIZER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: [`Forget query: ${query}`, `Message role: ${role}`, "Message text:", text].join("\n") }],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    },
    { apiKey },
  );

  const cleaned = response.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("")
    .trim();

  return cleaned;
}

async function sanitizeMessages(ctx: ExtensionContext, source: CleanContext, query: string): Promise<{ messages: CleanMessage[]; changed: boolean }> {
  const { model, apiKey } = await resolveSanitizerModel(ctx);
  const nextMessages: CleanMessage[] = [];
  let changed = false;

  for (const message of source.messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      nextMessages.push(message);
      continue;
    }

    const cleaned = await sanitizeMessageText(model, apiKey, query, message.role, message.content);
    const normalizedOriginal = message.content.trim();
    const normalizedCleaned = cleaned.trim();
    if (normalizedCleaned.length === 0) {
      if (normalizedOriginal.length > 0) changed = true;
      continue;
    }

    nextMessages.push({
      ...message,
      content: normalizedCleaned,
    });
    if (normalizedCleaned !== normalizedOriginal) changed = true;
  }

  return { messages: nextMessages, changed };
}

async function appendForgetState(pi: ExtensionAPI, cleanContext: CleanContext, sourceQuery: string): Promise<void> {
  pi.appendEntry<ForgetStateEntry>(STATE_ENTRY_TYPE, {
    active: true,
    sourceQuery,
    createdAt: new Date().toISOString(),
    cleanContext,
  });
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
    description: "Create a clean branch by sanitizing stale message text one message at a time: /forget <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /forget <query>", "error");
        return;
      }

      try {
        const source = buildSourceContext(ctx);
        const { messages, changed } = await sanitizeMessages(ctx, source, query);
        if (!changed) {
          ctx.ui.notify("No stale user/assistant message text was found to clean.", "warning");
          return;
        }

        const cleanContext: CleanContext = {
          systemPrompt: source.systemPrompt,
          retainedSummary: source.retainedSummary,
          messages,
        };

        const activated = await activateCleanBranch(pi, ctx, cleanContext, query);
        if (!activated) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`forget failed: ${message}`, "error");
      }
    },
  });
}
