import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import { forget, prepareForgetting } from "./core.ts";

interface PendingForget {
	id: number;
	query: string;
}

let nextForgetId = 1;
let pendingForget: PendingForget | undefined;

function mutableSessionManager(ctx: ExtensionContext): SessionManager {
	return ctx.sessionManager as unknown as SessionManager;
}

function currentThinkingLevel(sessionManager: SessionManager): ThinkingLevel | undefined {
	const level = sessionManager.buildSessionContext().thinkingLevel;
	if (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") {
		return level;
	}
	return undefined;
}

function forgetInstructions(query: string): string {
	return `Remove stale, conflicting, or irrelevant content matching this forget request: ${query}`;
}

export default function forgetExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const request = pendingForget;
		if (!request || !ctx.model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			return { cancel: true };
		}

		const sessionManager = mutableSessionManager(ctx);
		const settings = SettingsManager.create(ctx.cwd).getCompactionSettings();
		const preparation = prepareForgetting(event.branchEntries, settings);
		if (!preparation) {
			return { cancel: true };
		}

		try {
			const compaction = await forget(
				preparation,
				ctx.model,
				auth.apiKey,
				auth.headers,
				forgetInstructions(request.query),
				event.signal,
				currentThinkingLevel(sessionManager),
			);
			return { compaction };
		} catch {
			return { cancel: true };
		}
	});

	pi.registerCommand("forget", {
		description: "Run forget cleanup through Pi's compaction UI: /forget <query>",
		handler: (args, ctx) => {
			const query = args.trim();
			if (!query) return;

			const request: PendingForget = { id: nextForgetId++, query };
			pendingForget = request;
			ctx.compact({
				customInstructions: forgetInstructions(query),
				onComplete: () => {
					if (pendingForget?.id === request.id) pendingForget = undefined;
				},
				onError: () => {
					if (pendingForget?.id === request.id) pendingForget = undefined;
				},
			});
		},
	});
}
