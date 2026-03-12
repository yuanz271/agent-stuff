import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type LspOperation =
	| "goToDefinition"
	| "findReferences"
	| "hover"
	| "documentSymbol"
	| "workspaceSymbol"
	| "goToImplementation"
	| "prepareCallHierarchy"
	| "incomingCalls"
	| "outgoingCalls";

interface LspServerConfig {
	id: string;
	extensions: string[];
	commands: string[][];
	rootMarkers: string[];
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
	method?: string;
	params?: unknown;
}

interface JsonRpcError {
	code: number;
	message: string;
}

interface LspLocation {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

interface LspDiagnostic {
	severity?: number;
	message: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

const SERVERS: LspServerConfig[] = [
	{
		id: "typescript",
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		commands: [["typescript-language-server", "--stdio"]],
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
	},
	{
		id: "go",
		extensions: [".go"],
		commands: [["gopls"]],
		rootMarkers: ["go.mod", "go.work"],
	},
	{
		id: "python",
		extensions: [".py", ".pyi"],
		commands: [["ty", "server"], ["pyrefly", "lsp"], ["pyright-langserver", "--stdio"], ["basedpyright-langserver", "--stdio"]],
		rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "pyrightconfig.json"],
	},
];

const LOCATION_OPERATIONS = new Set<LspOperation>([
	"goToDefinition",
	"findReferences",
	"goToImplementation",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
]);

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".mts": "typescript",
	".cts": "typescript",
	".go": "go",
	".py": "python",
	".pyi": "python",
};

function hasCommand(command: string): boolean {
	const probe = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(probe, [command], { stdio: "ignore" });
	return result.status === 0;
}

function resolveLocalBinary(command: string, root: string): string | null {
	const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`] : [command];
	const candidates: string[] = [];
	for (const name of names) {
		candidates.push(path.join(root, "node_modules", ".bin", name));
		candidates.push(path.join(root, ".venv", "bin", name));
		candidates.push(path.join(root, "venv", "bin", name));
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function chooseCommand(config: LspServerConfig, root: string): string[] | null {
	for (const cmd of config.commands) {
		if (cmd.length === 0) continue;
		const binary = cmd[0]!;
		const local = resolveLocalBinary(binary, root);
		if (local) return [local, ...cmd.slice(1)];
		if (hasCommand(binary)) return cmd;
	}
	return null;
}

function commandLabel(command: string[]): string {
	if (command.length === 0) return "unknown";
	return path.basename(command[0]!);
}

function findNearestRoot(startFile: string, markers: string[], fallback: string): string {
	let current = path.dirname(startFile);
	while (true) {
		for (const marker of markers) {
			if (fs.existsSync(path.join(current, marker))) return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return fallback;
		current = parent;
	}
}

function normalizePath(inputPath: string, cwd: string): string {
	return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.normalize(path.join(cwd, inputPath));
}

function operationNeedsPosition(op: LspOperation): boolean {
	return (
		op === "goToDefinition" ||
		op === "findReferences" ||
		op === "hover" ||
		op === "goToImplementation" ||
		op === "prepareCallHierarchy" ||
		op === "incomingCalls" ||
		op === "outgoingCalls"
	);
}

function toFilePath(uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	try {
		return path.normalize(fileURLToPath(uri));
	} catch {
		return null;
	}
}

function isWorkspacePath(filePath: string, workspaceRoot: string): boolean {
	const root = path.resolve(workspaceRoot);
	const target = path.resolve(filePath);
	return target === root || target.startsWith(`${root}${path.sep}`);
}

function languageIdFor(filePath: string): string {
	return LANGUAGE_IDS[path.extname(filePath).toLowerCase()] ?? "plaintext";
}

function uniqueLocations(items: LspLocation[]): LspLocation[] {
	const seen = new Set<string>();
	const out: LspLocation[] = [];
	for (const item of items) {
		const key = `${item.uri}:${item.range.start.line}:${item.range.start.character}:${item.range.end.line}:${item.range.end.character}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

function coerceLocations(value: unknown): LspLocation[] {
	if (!value) return [];
	const arr = Array.isArray(value) ? value : [value];
	const locations: LspLocation[] = [];

	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;

		if (typeof rec.uri === "string" && rec.range && typeof rec.range === "object") {
			locations.push({
				uri: rec.uri,
				range: rec.range as LspLocation["range"],
			});
			continue;
		}

		if (typeof rec.targetUri === "string" && rec.targetRange && typeof rec.targetRange === "object") {
			locations.push({
				uri: rec.targetUri,
				range: rec.targetRange as LspLocation["range"],
			});
			continue;
		}

		if (rec.from && typeof rec.from === "object") {
			locations.push(...coerceLocations(rec.from));
		}
		if (rec.to && typeof rec.to === "object") {
			locations.push(...coerceLocations(rec.to));
		}
	}

	return uniqueLocations(locations);
}

function extractToolPath(input: unknown, cwd: string): string | null {
	if (!input || typeof input !== "object") return null;
	const rec = input as Record<string, unknown>;
	const rawPath = rec.path ?? rec.filePath;
	if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
	return normalizePath(rawPath, cwd);
}

function appendTextContent(content: unknown, suffix: string): unknown {
	if (!Array.isArray(content)) {
		return [{ type: "text", text: suffix.trim() }];
	}
	const parts = [...content] as Array<Record<string, unknown>>;
	parts.push({ type: "text", text: suffix });
	return parts;
}

function mergeDetails(details: unknown, patch: Record<string, unknown>): Record<string, unknown> {
	if (!details || typeof details !== "object") return patch;
	return { ...(details as Record<string, unknown>), ...patch };
}

class LspClient {
	private sequence = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private openedVersions = new Map<string, number>();
	private initialized = false;
	private diagnostics = new Map<string, LspDiagnostic[]>();
	private diagnosticsWaiters = new Map<string, Set<() => void>>();

	constructor(
		public readonly serverId: string,
		public readonly root: string,
		public readonly commandLabel: string,
		private readonly process: ChildProcessWithoutNullStreams,
		private readonly onExit?: () => void,
	) {
		this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.process.on("exit", () => {
			for (const [, pending] of this.pending) {
				pending.reject(new Error(`LSP client ${this.serverId} exited`));
			}
			this.pending.clear();
			this.onExit?.();
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			const header = this.buffer.slice(0, headerEnd).toString("utf-8");
			const contentLengthLine = header
				.split("\r\n")
				.find((line) => line.toLowerCase().startsWith("content-length:"));
			if (!contentLengthLine) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const contentLength = Number(contentLengthLine.split(":")[1]?.trim());
			if (!Number.isFinite(contentLength)) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const total = headerEnd + 4 + contentLength;
			if (this.buffer.length < total) return;

			const payload = this.buffer.slice(headerEnd + 4, total).toString("utf-8");
			this.buffer = this.buffer.slice(total);

			let msg: JsonRpcResponse;
			try {
				msg = JSON.parse(payload) as JsonRpcResponse;
			} catch {
				continue;
			}

			if (msg.method === "textDocument/publishDiagnostics" && msg.params && typeof msg.params === "object") {
				const params = msg.params as { uri?: string; diagnostics?: LspDiagnostic[] };
				if (typeof params.uri === "string") {
					const filePath = toFilePath(params.uri);
					if (filePath) {
						this.diagnostics.set(filePath, Array.isArray(params.diagnostics) ? params.diagnostics : []);
						const waiters = this.diagnosticsWaiters.get(filePath);
						if (waiters) {
							for (const resolve of waiters) resolve();
							this.diagnosticsWaiters.delete(filePath);
						}
					}
				}
			}

			if (msg.method && typeof msg.id === "number") {
				switch (msg.method) {
					case "workspace/configuration":
						this.respond(msg.id, [{}]);
						break;
					case "window/workDoneProgress/create":
					case "client/registerCapability":
					case "client/unregisterCapability":
						this.respond(msg.id, null);
						break;
					case "workspace/workspaceFolders":
						this.respond(msg.id, [
							{ name: path.basename(this.root), uri: pathToFileURL(this.root).href },
						]);
						break;
					default:
						this.respond(msg.id, null);
				}
				continue;
			}

			if (typeof msg.id === "number") {
				const pending = this.pending.get(msg.id);
				if (!pending) continue;
				this.pending.delete(msg.id);
				if (msg.error) pending.reject(new Error(msg.error.message || "LSP request failed"));
				else pending.resolve(msg.result);
			}
		}
	}

	private send(payload: object): void {
		const json = JSON.stringify(payload);
		const body = Buffer.from(json, "utf-8");
		const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf-8");
		this.process.stdin.write(Buffer.concat([header, body]));
	}

	private respond(id: number, result?: unknown, error?: JsonRpcError): void {
		this.send({ jsonrpc: "2.0", id, ...(error ? { error } : { result: result ?? null }) });
	}

	private async request(method: string, params?: unknown, timeoutMs = 45_000): Promise<unknown> {
		const id = this.sequence++;
		const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		return await new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request timeout for ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			this.send(payload);
		});
	}

	private notify(method: string, params?: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.request("initialize", {
			processId: this.process.pid,
			rootUri: pathToFileURL(this.root).href,
			workspaceFolders: [{ name: path.basename(this.root), uri: pathToFileURL(this.root).href }],
			capabilities: {
				workspace: { configuration: true },
				textDocument: {
					synchronization: { didOpen: true, didChange: true },
					publishDiagnostics: { versionSupport: true },
				},
			},
		});
		this.notify("initialized", {});
		this.initialized = true;
	}

	private waitForDiagnostics(filePath: string, timeoutMs = 3_000): Promise<void> {
		const abs = path.resolve(filePath);
		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				const waiters = this.diagnosticsWaiters.get(abs);
				waiters?.delete(done);
				if (waiters && waiters.size === 0) this.diagnosticsWaiters.delete(abs);
				resolve();
			}, timeoutMs);

			const done = () => {
				clearTimeout(timeout);
				resolve();
			};

			const waiters = this.diagnosticsWaiters.get(abs) ?? new Set<() => void>();
			waiters.add(done);
			this.diagnosticsWaiters.set(abs, waiters);
		});
	}

	getDiagnostics(filePath: string): LspDiagnostic[] {
		return this.diagnostics.get(path.resolve(filePath)) ?? [];
	}

	async touchFile(filePath: string, waitForDiagnostics = false): Promise<void> {
		const abs = path.resolve(filePath);
		const text = fs.readFileSync(abs, "utf-8");
		const uri = pathToFileURL(abs).href;
		const languageId = languageIdFor(abs);
		const version = this.openedVersions.get(abs);
		const wait = waitForDiagnostics ? this.waitForDiagnostics(abs) : Promise.resolve();

		if (version === undefined) {
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: 0,
					text,
				},
			});
			this.openedVersions.set(abs, 0);
			await wait;
			return;
		}

		const nextVersion = version + 1;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: nextVersion },
			contentChanges: [{ text }],
		});
		this.openedVersions.set(abs, nextVersion);
		await wait;
	}

	async call(operation: LspOperation, args: { filePath: string; line?: number; character?: number; query?: string }): Promise<unknown> {
		const uri = pathToFileURL(path.resolve(args.filePath)).href;
		const position = {
			line: Math.max(0, (args.line ?? 1) - 1),
			character: Math.max(0, (args.character ?? 1) - 1),
		};

		switch (operation) {
			case "goToDefinition":
				return await this.request("textDocument/definition", { textDocument: { uri }, position });
			case "findReferences":
				return await this.request("textDocument/references", {
					textDocument: { uri },
					position,
					context: { includeDeclaration: true },
				});
			case "hover":
				return await this.request("textDocument/hover", { textDocument: { uri }, position });
			case "documentSymbol":
				return await this.request("textDocument/documentSymbol", { textDocument: { uri } });
			case "workspaceSymbol":
				return await this.request("workspace/symbol", { query: args.query ?? "" });
			case "goToImplementation":
				return await this.request("textDocument/implementation", { textDocument: { uri }, position });
			case "prepareCallHierarchy":
				return await this.request("textDocument/prepareCallHierarchy", { textDocument: { uri }, position });
			case "incomingCalls": {
				const items = (await this.request("textDocument/prepareCallHierarchy", {
					textDocument: { uri },
					position,
				})) as unknown[];
				if (!Array.isArray(items) || items.length === 0) return [];
				return await this.request("callHierarchy/incomingCalls", { item: items[0] });
			}
			case "outgoingCalls": {
				const items = (await this.request("textDocument/prepareCallHierarchy", {
					textDocument: { uri },
					position,
				})) as unknown[];
				if (!Array.isArray(items) || items.length === 0) return [];
				return await this.request("callHierarchy/outgoingCalls", { item: items[0] });
			}
		}
	}

	shutdown(): void {
		this.process.kill();
	}
}

export default function lspExtension(pi: ExtensionAPI): void {
	const clients = new Map<string, LspClient>();
	const spawning = new Map<string, Promise<LspClient | null>>();
	let lastUiContext: ExtensionContext | null = null;
	let queryInFlight = 0;
	let queryVisibleUntil = 0;

	const markQueryStart = (ctx: ExtensionContext) => {
		queryInFlight++;
		queryVisibleUntil = Date.now() + 1200;
		lastUiContext = ctx;
		updateStatus(ctx);
	};

	const markQueryEnd = (ctx: ExtensionContext) => {
		queryInFlight = Math.max(0, queryInFlight - 1);
		queryVisibleUntil = Date.now() + 700;
		lastUiContext = ctx;
		updateStatus(ctx);
	};

	function updateStatus(ctx?: ExtensionContext | null): void {
		const target = ctx ?? lastUiContext;
		if (!target?.hasUI) return;
		target.ui.setWidget("lsp-status", undefined);
		if (queryInFlight > 0 || Date.now() < queryVisibleUntil) {
			target.ui.setStatus("lsp", target.ui.theme.fg("warning", "LSP: querying"));
			return;
		}
		target.ui.setStatus("lsp", target.ui.theme.fg("dim", "LSP: idle"));
	}

	async function getOrSpawnClient(key: string, server: LspServerConfig, root: string, ctx?: ExtensionContext): Promise<LspClient | null> {
		const existing = clients.get(key);
		if (existing) return existing;

		const inflight = spawning.get(key);
		if (inflight) return await inflight;

		const task = (async () => {
			const command = chooseCommand(server, root);
			if (!command) return null;
			const child = spawn(command[0]!, command.slice(1), {
				cwd: root,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			const client = new LspClient(server.id, root, commandLabel(command), child, () => {
				clients.delete(key);
				updateStatus();
			});
			await client.initialize();
			clients.set(key, client);
			updateStatus(ctx);
			return client;
		})().finally(() => {
			if (spawning.get(key) === task) spawning.delete(key);
		});

		spawning.set(key, task);
		return await task;
	}

	async function getClientsForFile(filePath: string, cwd: string, ctx?: ExtensionContext): Promise<LspClient[]> {
		const abs = path.resolve(filePath);
		const ext = path.extname(abs).toLowerCase();
		const matching = SERVERS.filter((server) => server.extensions.includes(ext));
		const result: LspClient[] = [];

		for (const server of matching) {
			const root = findNearestRoot(abs, server.rootMarkers, cwd);
			const key = `${server.id}:${root}`;
			const client = await getOrSpawnClient(key, server, root, ctx);
			if (client) result.push(client);
		}

		return result;
	}

	function statusLines(): string[] {
		if (clients.size === 0) return ["LSP: idle"];
		const lines = ["LSP clients:"];
		for (const [key, client] of clients.entries()) {
			lines.push(`- ${client.commandLabel} @ ${client.root} (${key})`);
		}
		if (spawning.size > 0) {
			lines.push(`Spawning: ${spawning.size}`);
		}
		return lines;
	}

	async function reloadClients(ctx: ExtensionContext): Promise<void> {
		for (const client of clients.values()) {
			client.shutdown();
		}
		clients.clear();
		spawning.clear();
		queryInFlight = 0;
		queryVisibleUntil = 0;
		updateStatus(ctx);
	}

	pi.registerCommand("lsp-status", {
		description: "Show background LSP runtime status",
		handler: async (_args, ctx) => {
			lastUiContext = ctx;
			updateStatus(ctx);
			pi.sendMessage(
				{ customType: "lsp-status", content: statusLines().join("\n"), display: true },
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("lsp-reload", {
		description: "Reload background LSP clients",
		handler: async (_args, ctx) => {
			lastUiContext = ctx;
			await reloadClients(ctx);
			ctx.ui.notify("LSP clients reloaded.", "success");
		},
	});

	// Lightweight querying indicator (only active when lsp_query exists and is called).
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "lsp_query") return;
		markQueryStart(ctx);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "lsp_query") return;
		markQueryEnd(ctx);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		try {
			const filePath = extractToolPath(event.input, ctx.cwd);
			if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return;

			const activeClients = await getClientsForFile(filePath, ctx.cwd, ctx);
			if (activeClients.length === 0) return;

			await Promise.all(activeClients.map((client) => client.touchFile(filePath, true)));
			const errors = activeClients.flatMap((client) =>
				client
					.getDiagnostics(filePath)
					.filter((diag) => diag.severity === 1)
					.map((diag) => ({ server: client.serverId, diagnostic: diag })),
			);
			if (errors.length === 0) return;

			const rel = path.relative(ctx.cwd, filePath);
			const shown = errors.slice(0, 12);
			const lines = shown.map(
				(item) =>
					`- [${item.server}] ${item.diagnostic.range.start.line + 1}:${item.diagnostic.range.start.character + 1} ${item.diagnostic.message}`,
			);
			if (errors.length > shown.length) lines.push(`- … ${errors.length - shown.length} more`);

			return {
				content: appendTextContent(
					event.content,
					`\nLSP found ${errors.length} error(s) in ${rel}. Fix these before finalizing:\n${lines.join("\n")}`,
				),
				details: mergeDetails(event.details, {
					lspDiagnostics: {
						filePath,
						errorCount: errors.length,
						errors,
					},
				}),
			};
		} catch {
			// Never block normal write/edit flow if LSP is unavailable or misconfigured.
			return;
		}
	});


	pi.on("session_start", async (_event, ctx) => {
		lastUiContext = ctx;
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastUiContext = ctx;
		updateStatus(ctx);
	});

	// Helps re-assert footer status after extension reloads where session_start/switch may not fire.
	pi.on("session_tree", async (_event, ctx) => {
		lastUiContext = ctx;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const client of clients.values()) {
			client.shutdown();
		}
		clients.clear();
		spawning.clear();
		queryInFlight = 0;
		queryVisibleUntil = 0;
		updateStatus();
	});
}
