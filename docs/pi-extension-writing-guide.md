# How to Write a Pi Extension

Summary based on the [pi-mono](https://github.com/badlogic/pi-mono) repository and the official extension documentation.

---

## 1. What Is a Pi Extension?

A pi extension is a **TypeScript module** that exports a default function receiving an `ExtensionAPI` object. Extensions can:

- **Register custom tools** the LLM can call
- **Subscribe to lifecycle events** (session, agent, tool, model, input events)
- **Register slash commands** (`/mycommand`)
- **Register keyboard shortcuts**
- **Register CLI flags**
- **Interact with users** via dialogs, widgets, and custom TUI components
- **Persist state** across session restarts
- **Customize rendering** of tool calls, results, and messages
- **Register model providers** (custom endpoints, proxies, OAuth)

---

## 2. File Placement

Extensions are auto-discovered from these locations:

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |

For quick testing, use the CLI flag:
```bash
pi -e ./my-extension.ts
```

Extensions in auto-discovered locations can be hot-reloaded with `/reload`.

---

## 3. Minimal Extension (Hello World)

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "hello",
    label: "Hello",
    description: "A simple greeting tool",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: { greeted: params.name },
      };
    },
  });
}
```

---

## 4. Available Imports

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Extension types (`ExtensionAPI`, `ExtensionContext`, event types, type guards) |
| `@sinclair/typebox` | Schema definitions for tool parameters (`Type.Object`, `Type.String`, etc.) |
| `@mariozechner/pi-ai` | AI utilities (`StringEnum` for Google-compatible enums, `complete()`, `getModel()`) |
| `@mariozechner/pi-tui` | TUI components (`Text`, `Container`, `Markdown`, `matchesKey`, `Key`) |

Node.js built-ins (`node:fs`, `node:path`, etc.) are also available. npm dependencies work when a `package.json` is present.

---

## 5. Extension Structure Options

### Single file
```
~/.pi/agent/extensions/my-extension.ts
```

### Directory with index.ts
```
~/.pi/agent/extensions/my-extension/
├── index.ts        # Entry point (exports default function)
├── tools.ts        # Helper modules
└── utils.ts
```

### Package with npm dependencies
```
~/.pi/agent/extensions/my-extension/
├── package.json    # Declares dependencies
├── node_modules/
└── src/
    └── index.ts
```

```json
{
  "name": "my-extension",
  "dependencies": { "zod": "^3.0.0" },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

---

## 6. Core API: `ExtensionAPI` (the `pi` object)

### 6.1 Event Subscription — `pi.on(event, handler)`

Every handler receives `(event, ctx: ExtensionContext)`. Key events:

| Event | When | Can Return |
|-------|------|------------|
| `session_start` | Session loads | — |
| `session_shutdown` | Exit (Ctrl+C) | — |
| `session_before_switch` | Before `/new` or `/resume` | `{ cancel: true }` |
| `session_switch` | After session switch | — |
| `session_before_fork` | Before `/fork` | `{ cancel: true }` |
| `session_before_compact` | Before compaction | `{ cancel: true }` or custom compaction |
| `before_agent_start` | After user prompt, before agent loop | `{ message, systemPrompt }` |
| `agent_start` / `agent_end` | Agent loop boundaries | — |
| `turn_start` / `turn_end` | Each LLM response cycle | — |
| `context` | Before each LLM call | `{ messages }` (modified copy) |
| `tool_call` | Before tool executes | `{ block: true, reason }` |
| `tool_result` | After tool executes | `{ content, details, isError }` |
| `input` | User input received | `{ action: "continue" | "transform" | "handled" }` |
| `model_select` | Model changes | — |
| `user_bash` | User `!` command | `{ operations }` or `{ result }` |

### 6.2 Register Custom Tool — `pi.registerTool(definition)`

```typescript
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // Use StringEnum for Google compatibility
    text: Type.Optional(Type.String()),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // signal — AbortSignal for cancellation
    // onUpdate — stream partial results: onUpdate?.({ content: [...], details: {} })
    // ctx — ExtensionContext (has ctx.ui for user interaction)

    return {
      content: [{ type: "text", text: "Done" }],   // Sent to LLM
      details: { data: "..." },                     // For rendering & state reconstruction
    };
  },

  // Optional: custom TUI rendering
  renderCall(args, theme) { /* return Component */ },
  renderResult(result, { expanded, isPartial }, theme) { /* return Component */ },
});
```

**Important:** Use `StringEnum` from `@mariozechner/pi-ai` instead of `Type.Union`/`Type.Literal` for enum parameters (Google API compatibility).

### 6.3 Register Command — `pi.registerCommand(name, options)`

```typescript
pi.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    // ctx is ExtensionCommandContext (extends ExtensionContext)
    // Has: ctx.waitForIdle(), ctx.newSession(), ctx.fork(), ctx.navigateTree(), ctx.reload()
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  },
  // Optional: argument auto-completion
  getArgumentCompletions: (prefix) => {
    return [{ value: "all", label: "all" }].filter(i => i.value.startsWith(prefix));
  },
});
```

### 6.4 Other Registration

```typescript
// Keyboard shortcut
pi.registerShortcut("ctrl+shift+p", {
  description: "Toggle feature",
  handler: async (ctx) => { /* ... */ },
});

// CLI flag
pi.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});
// Check: pi.getFlag("plan")

// Custom message renderer
pi.registerMessageRenderer("my-type", (message, { expanded }, theme) => {
  return new Text(theme.fg("accent", message.content), 0, 0);
});

// Model provider
pi.registerProvider("my-proxy", { baseUrl: "...", apiKey: "...", api: "anthropic-messages", models: [...] });
```

### 6.5 Messaging

```typescript
// Custom message (not a user message)
pi.sendMessage({
  customType: "my-ext",
  content: "Context for LLM",
  display: true,             // Show in TUI
  details: { ... },
}, { triggerTurn: true, deliverAs: "steer" });  // "steer" | "followUp" | "nextTurn"

// User message (triggers a turn)
pi.sendUserMessage("What is 2+2?");

// Persist state (not sent to LLM)
pi.appendEntry("my-state", { count: 42 });

// Tool management
pi.setActiveTools(["read", "bash"]);    // Restrict available tools
const tools = pi.getActiveTools();
const all = pi.getAllTools();

// Model management
pi.setModel(model);
pi.setThinkingLevel("high");

// Shell execution
const result = await pi.exec("git", ["status"], { timeout: 5000 });

// Inter-extension communication
pi.events.on("my:event", (data) => { ... });
pi.events.emit("my:event", { ... });
```

---

## 7. Extension Context (`ctx`)

Every event handler receives `ctx: ExtensionContext`:

| Property/Method | Description |
|-----------------|-------------|
| `ctx.ui` | UI methods (dialogs, widgets, status, etc.) |
| `ctx.hasUI` | `false` in print mode (`-p`) and JSON mode |
| `ctx.cwd` | Current working directory |
| `ctx.sessionManager` | Read-only session access (`.getEntries()`, `.getBranch()`, `.getLeafId()`) |
| `ctx.modelRegistry` | Model and API key access |
| `ctx.model` | Current model |
| `ctx.isIdle()` | Whether agent is idle |
| `ctx.abort()` | Abort current operation |
| `ctx.shutdown()` | Graceful shutdown |
| `ctx.getContextUsage()` | Token usage stats |
| `ctx.compact()` | Trigger compaction |
| `ctx.getSystemPrompt()` | Current system prompt |

### UI Methods (`ctx.ui`)

```typescript
// Dialogs
const choice = await ctx.ui.select("Pick:", ["A", "B", "C"]);
const ok = await ctx.ui.confirm("Delete?", "Are you sure?");
const name = await ctx.ui.input("Name:", "placeholder");
const text = await ctx.ui.editor("Edit:", "prefilled");

// Timed dialogs
const ok = await ctx.ui.confirm("Title", "Auto-cancel in 5s", { timeout: 5000 });

// Non-blocking
ctx.ui.notify("Done!", "info");            // "info" | "warning" | "error"
ctx.ui.setStatus("key", "Processing...");  // Footer status
ctx.ui.setWidget("key", ["Line 1"]);       // Widget above editor

// Custom component (takes over editor area until done())
const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  // Return a Component with render(), invalidate(), handleInput()
});
```

---

## 8. State Management Pattern

Store state in tool result `details` for proper branching support. Reconstruct from session on load:

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct on session events
  const reconstruct = (ctx: ExtensionContext) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult" 
          && entry.message.toolName === "my_tool") {
        items = entry.message.details?.items ?? [];
      }
    }
  };

  pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
  pi.on("session_switch", async (_e, ctx) => reconstruct(ctx));
  pi.on("session_fork", async (_e, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // Snapshot for reconstruction
      };
    },
  });
}
```

For non-tool state, use `pi.appendEntry("my-state", data)` and reconstruct from custom entries on `session_start`.

---

## 9. Common Patterns (from Examples)

### Permission Gate (block dangerous commands)
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && /rm\s+-rf/.test(event.input.command)) {
    const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

### Modify System Prompt per Turn
```typescript
pi.on("before_agent_start", async (event) => {
  return { systemPrompt: event.systemPrompt + "\n\nExtra instructions..." };
});
```

### Filter Context Messages
```typescript
pi.on("context", async (event) => {
  return { messages: event.messages.filter(m => !shouldPrune(m)) };
});
```

### Transform User Input
```typescript
pi.on("input", async (event) => {
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };
  return { action: "continue" };
});
```

### Read-only planning pattern

A read-only planning extension often follows this pattern:
1. **Toggle planning mode** via a command, flag, or shortcut
2. **Restrict tools** to a read-only set (`read`, `bash`, `grep`, `find`, `ls`)
3. **Block destructive bash** commands via `tool_call` event with allowlist/blocklist
4. **Inject context** via `before_agent_start` telling the LLM it's in read-only mode
5. **Extract plan steps** from assistant output (for example numbered items under a `Plan:` header)
6. **Track execution** progress with markers and a widget
7. **Persist state** with `pi.appendEntry()` and reconstruct on `session_start`

---

## 10. Output Truncation

Tools **must** truncate output to avoid context overflow. Built-in limit: **50KB / 2000 lines**.

```typescript
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";

const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
let result = truncation.content;
if (truncation.truncated) {
  result += `\n[Truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`;
}
```

---

## 11. Custom Rendering

Tool definitions can include `renderCall` and `renderResult` for custom TUI display:

```typescript
import { Text } from "@mariozechner/pi-tui";

pi.registerTool({
  // ...
  renderCall(args, theme) {
    return new Text(theme.fg("toolTitle", theme.bold("my_tool ")) + theme.fg("muted", args.action), 0, 0);
  },
  renderResult(result, { expanded, isPartial }, theme) {
    if (isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);
    let text = theme.fg("success", "✓ Done");
    if (expanded && result.details?.items) {
      for (const item of result.details.items) {
        text += "\n  " + theme.fg("dim", item);
      }
    }
    return new Text(text, 0, 0);
  },
});
```

- Use `Text` with padding `(0, 0)` — the wrapping `Box` handles padding
- Handle `isPartial` for streaming progress
- Support `expanded` for toggleable detail (Ctrl+O)
- If omitted, built-in renderers are used as fallback

---

## 12. Overriding Built-in Tools

Register a tool with the same name as a built-in (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`):

```typescript
pi.registerTool({
  name: "read",  // Overrides built-in read
  // ... your implementation
});
```

Or use `--no-tools` to start with no built-ins:
```bash
pi --no-tools -e ./my-extension.ts
```

Your override must match the exact result shape (including `details` type) for the built-in renderer to work.

---

## 13. Error Handling

- Extension errors are **logged but don't crash** the agent
- `tool_call` handler errors **block the tool** (fail-safe)
- Tool `execute` errors are reported to the LLM with `isError: true`

---

## 14. Mode Behavior

| Mode | UI | Notes |
|------|-----|-------|
| Interactive | Full TUI | Normal |
| RPC (`--mode rpc`) | JSON protocol | Host handles UI |
| JSON (`--mode json`) | No-op | Events to stdout |
| Print (`-p`) | No-op | Extensions run, can't prompt |

Check `ctx.hasUI` before using interactive UI methods in non-interactive modes.

---

## 15. Examples Reference (from pi-mono)

| Category | Examples |
|----------|---------|
| **Tools** | `hello.ts`, `todo.ts`, `question.ts`, `questionnaire.ts`, `truncated-tool.ts`, `tool-override.ts` |
| **Commands** | `pirate.ts`, `summarize.ts`, `handoff.ts`, `send-user-message.ts`, `reload-runtime.ts` |
| **Event Gates** | `permission-gate.ts`, `protected-paths.ts`, `confirm-destructive.ts`, `dirty-repo-guard.ts` |
| **Input** | `input-transform.ts`, `claude-rules.ts` |
| **UI** | `status-line.ts`, `custom-footer.ts`, `widget-placement.ts`, `snake.ts`, `space-invaders.ts` |
| **Sessions** | `custom-compaction.ts`, `git-checkpoint.ts`, `auto-commit-on-exit.ts` |
| **Complex** | `preset.ts`, `ssh.ts`, `subagent/` |
| **Providers** | `custom-provider-anthropic/`, `custom-provider-gitlab-duo/` |

All located in `packages/coding-agent/examples/extensions/` in the pi-mono repo.
