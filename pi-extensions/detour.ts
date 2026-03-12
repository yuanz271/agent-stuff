import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DETOUR_STATE_TYPE = "detour-session";
const DETOUR_ANCHOR_TYPE = "detour-anchor";
const DETOUR_STATUS_KEY = "detour";

interface DetourSessionState {
	active: boolean;
	originId?: string;
}

interface DetourEndOptions {
	summary: boolean;
}

function getDetourState(ctx: ExtensionContext): DetourSessionState | undefined {
	let state: DetourSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === DETOUR_STATE_TYPE) {
			state = entry.data as DetourSessionState | undefined;
		}
	}
	return state;
}

function setDetourStatus(ctx: ExtensionContext, active: boolean): void {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setStatus(DETOUR_STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(DETOUR_STATUS_KEY, ctx.ui.theme.fg("warning", "DETOUR"));
}

export default function detourExtension(pi: ExtensionAPI): void {
	let detourOriginId: string | undefined;

	const applyDetourState = (ctx: ExtensionContext) => {
		const state = getDetourState(ctx);
		if (state?.active && state.originId) {
			detourOriginId = state.originId;
			setDetourStatus(ctx, true);
			return;
		}
		detourOriginId = undefined;
		setDetourStatus(ctx, false);
	};

	const getActiveOrigin = (ctx: ExtensionContext): string | undefined => {
		if (detourOriginId) return detourOriginId;
		const state = getDetourState(ctx);
		if (state?.active && state.originId) {
			detourOriginId = state.originId;
			return detourOriginId;
		}
		return undefined;
	};

	const BLOCKED_TOOLS = new Set(["write", "edit", "apply_patch", "todo", "send_to_session"]);

	const parseDetourEndOptions = (args?: string): DetourEndOptions => {
		const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
		return { summary: tokens.includes("--summary") };
	};

	const extractTextContent = (entry: unknown): string => {
		if (!entry || typeof entry !== "object") return "";
		const message = (entry as { message?: unknown }).message as { content?: unknown } | undefined;
		if (!message || !Array.isArray(message.content)) return "";
		return message.content
			.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim();
	};

	const truncate = (text: string, max = 500): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

	const buildDetourSummary = (ctx: ExtensionContext, originId: string): string | null => {
		const branch = ctx.sessionManager.getBranch();
		const originIdx = branch.findIndex((entry) => entry.id === originId);
		const segment = originIdx >= 0 ? branch.slice(originIdx + 1) : branch;

		const messages = segment.filter(
			(entry) =>
				entry.type === "message" &&
				(entry.message.role === "user" || (entry.message.role === "assistant" && entry.message.stopReason === "stop")),
		);
		if (messages.length === 0) return null;

		const lines: string[] = [""]; 
		let pairCount = 0;
		const maxPairs = 4;

		for (let i = 0; i < messages.length && pairCount < maxPairs; i++) {
			const current = messages[i];
			if (!current || current.type !== "message" || current.message.role !== "user") continue;

			const q = truncate(extractTextContent(current).replace(/\s+/g, " "), 260);
			if (!q) continue;
			lines.push(`Q: ${q}`);

			let answerText = "(no assistant answer)";
			for (let j = i + 1; j < messages.length; j++) {
				const next = messages[j];
				if (!next || next.type !== "message") continue;
				if (next.message.role === "assistant") {
					const a = truncate(extractTextContent(next).replace(/\s+/g, " "), 420);
					if (a) answerText = a;
					i = j;
					break;
				}
				if (next.message.role === "user") {
					// No assistant answer before next user message.
					i = j - 1;
					break;
				}
			}
			lines.push(`A: ${answerText}`, "");
			pairCount++;
		}

		if (pairCount === 0) return null;
		const totalQuestions = messages.filter((m) => m.type === "message" && m.message.role === "user").length;
		if (totalQuestions > pairCount) {
			lines.push(`… ${totalQuestions - pairCount} more question(s) in detour branch`);
		}

		return lines.join("\n").trim();
	};

	const startDetour = async (ctx: ExtensionCommandContext, initialQuestion?: string): Promise<void> => {
		const activeOrigin = getActiveOrigin(ctx);
		if (activeOrigin) {
			setDetourStatus(ctx, true);
			if (initialQuestion?.trim()) {
				pi.sendUserMessage(initialQuestion.trim());
				return;
			}
			ctx.ui.notify("Detour already active. Ask a question or run /detour-end.", "info");
			return;
		}

		let originId = ctx.sessionManager.getLeafId() ?? undefined;
		if (!originId) {
			pi.appendEntry(DETOUR_ANCHOR_TYPE, { createdAt: new Date().toISOString() });
			originId = ctx.sessionManager.getLeafId() ?? undefined;
		}
		if (!originId) {
			ctx.ui.notify("Failed to start detour: could not determine origin.", "error");
			return;
		}

		detourOriginId = originId;
		pi.appendEntry(DETOUR_STATE_TYPE, { active: true, originId });
		setDetourStatus(ctx, true);
		ctx.ui.notify("Detour mode active. Mutating tools are blocked (read-only) until /detour-end.", "info");

		if (initialQuestion?.trim()) {
			pi.sendUserMessage(initialQuestion.trim());
		}
	};

	const endDetour = async (ctx: ExtensionCommandContext, options: DetourEndOptions): Promise<void> => {
		const originId = getActiveOrigin(ctx);
		if (!originId) {
			setDetourStatus(ctx, false);
			ctx.ui.notify("Detour mode is not active.", "info");
			return;
		}

		const summary = options.summary ? buildDetourSummary(ctx, originId) : null;
		const result = await ctx.navigateTree(originId, { summarize: false });
		if (result.cancelled) {
			ctx.ui.notify("Detour exit cancelled.", "info");
			return;
		}

		detourOriginId = undefined;
		pi.appendEntry(DETOUR_STATE_TYPE, { active: false });
		setDetourStatus(ctx, false);
		if (summary) {
			pi.sendMessage({ customType: "detour-summary", content: summary, display: true }, { triggerTurn: false });
			ctx.ui.notify("Returned from detour with summary.", "success");
			return;
		}
		ctx.ui.notify("Returned from detour.", "success");
	};

	pi.registerCommand("detour", {
		description: "Ask side questions in an isolated branch (write/edit blocked)",
		handler: async (args, ctx) => {
			await startDetour(ctx, args);
		},
	});

	pi.registerCommand("detour-end", {
		description: "Return to original branch and exit detour mode (use --summary to keep a visible recap)",
		handler: async (args, ctx) => {
			await endDetour(ctx, parseDetourEndOptions(args));
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!BLOCKED_TOOLS.has(event.toolName)) return undefined;
		if (!getActiveOrigin(ctx)) return undefined;

		const toolPath = (event.input as { path?: string } | undefined)?.path;
		const suffix = typeof toolPath === "string" ? `: ${toolPath}` : "";
		if (ctx.hasUI) {
			ctx.ui.notify(`Blocked ${event.toolName} in detour mode${suffix}`, "warning");
		}
		return {
			block: true,
			reason: `Detour mode is read-only. ${event.toolName} is blocked until /detour-end.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		applyDetourState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		applyDetourState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		applyDetourState(ctx);
	});

	pi.on("session_shutdown", async () => {
		detourOriginId = undefined;
	});
}
