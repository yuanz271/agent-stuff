import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import { forget, prepareForgetting } from "./core.ts";

function notify(ctx: ExtensionContext, message: string, severity: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, severity);
}

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

async function runForgetCommand(ctx: ExtensionCommandContext, query: string): Promise<void> {
	await ctx.waitForIdle();

	if (!ctx.model) {
		throw new Error("no active model selected");
	}

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error("current session has no session file");
	}

	const sessionManager = mutableSessionManager(ctx);
	const branchEntries = ctx.sessionManager.getBranch();
	const settings = SettingsManager.create(ctx.cwd).getCompactionSettings();
	const preparation = prepareForgetting(branchEntries, settings);
	if (!preparation) {
		throw new Error("no forgettable context found");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`no API key for ${ctx.model.provider}`);
	}

	const result = await forget(
		preparation,
		ctx.model,
		auth.apiKey,
		auth.headers,
		`Remove stale, conflicting, or irrelevant content matching this forget request: ${query}`,
		ctx.signal,
		currentThinkingLevel(sessionManager),
	);

	sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);

	await ctx.switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			notify(nextCtx, "Forget cleanup complete.", "info");
		},
	});
}

export default function forgetExtension(pi: ExtensionAPI) {
	pi.registerCommand("forget", {
		description: "Run copied forget cleanup directly: /forget <query>",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				notify(ctx, "Usage: /forget <query>", "error");
				return;
			}

			try {
				notify(ctx, "Running forget cleanup...", "info");
				await runForgetCommand(ctx, query);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `forget failed: ${message}`, "error");
			}
		},
	});
}
