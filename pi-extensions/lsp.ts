import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type LspOperation =
	| "goToDefinition"
	| "findReferences"
	| "hover"
	| "documentSymbol"
	| "workspaceSymbol";

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
		commands: [["pyright-langserver", "--stdio"], ["basedpyright-langserver", "--stdio"]],
		rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py"],
	},
];

function hasCommand(command: string): boolean {
	const probe = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(probe, [command], { stdio: "ignore" });
	return result.status === 0;
}

function chooseCommand(config: LspServerConfig): string[] | null {
	for (const cmd of config.commands) {
		if (cmd.length > 0 && hasCommand(cmd[0]!)) return cmd;
	}
	return null;
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
	return path.isAbsolute(inputPath) ? inputPath : path.join(cwd, inputPath);
}

class LspClient {
	private sequence = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private openedVersions = new Map<string, number>();
	private initialized = false;

	constructor(
		public readonly serverId: string,
		public readonly root: string,
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

	private async request(method: string, params?: unknown, timeoutMs = 20_000): Promise<unknown> {
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
				},
			},
		});
		this.notify("initialized", {});
		this.initialized = true;
	}

	async touchFile(filePath: string): Promise<void> {
		const abs = path.resolve(filePath);
		const text = fs.readFileSync(abs, "utf-8");
		const uri = pathToFileURL(abs).href;
		const version = this.openedVersions.get(abs);
		if (version === undefined) {
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: "plaintext",
					version: 0,
					text,
				},
			});
			this.openedVersions.set(abs, 0);
			return;
		}
		const nextVersion = version + 1;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: nextVersion },
			contentChanges: [{ text }],
		});
		this.openedVersions.set(abs, nextVersion);
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
		}
	}

	shutdown(): void {
		this.process.kill();
	}
}

function operationNeedsPosition(op: LspOperation): boolean {
	return op === "goToDefinition" || op === "findReferences" || op === "hover";
}

export default function lspExtension(pi: ExtensionAPI): void {
	const clients = new Map<string, LspClient>();
	let lastUiContext: ExtensionContext | null = null;

	function updateStatus(ctx?: ExtensionContext | null): void {
		const target = ctx ?? lastUiContext;
		if (!target?.hasUI) return;
		if (clients.size === 0) {
			target.ui.setStatus("lsp", undefined);
			return;
		}
		const serverIds = Array.from(new Set(Array.from(clients.values()).map((client) => client.serverId))).sort();
		target.ui.setStatus("lsp", `LSP: ${clients.size} (${serverIds.join(",")})`);
	}

	async function getClientsForFile(filePath: string, cwd: string, ctx?: ExtensionContext): Promise<LspClient[]> {
		const abs = path.resolve(filePath);
		const ext = path.extname(abs).toLowerCase();
		const matching = SERVERS.filter((server) => server.extensions.includes(ext));
		const result: LspClient[] = [];

		for (const server of matching) {
			const command = chooseCommand(server);
			if (!command) continue;
			const root = findNearestRoot(abs, server.rootMarkers, cwd);
			const key = `${server.id}:${root}`;
			let client = clients.get(key);
			if (!client) {
				const child = spawn(command[0]!, command.slice(1), {
					cwd: root,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				client = new LspClient(server.id, root, child, () => {
					clients.delete(key);
					updateStatus();
				});
				await client.initialize();
				clients.set(key, client);
				updateStatus(ctx);
			}
			result.push(client);
		}

		return result;
	}

	pi.registerTool({
		name: "lsp_query",
		label: "LSP Query",
		description:
			"Query language servers with lazy auto-start for code intelligence (definition, references, hover, symbols).",
		parameters: Type.Object({
			operation: StringEnum(
				["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol"] as const,
				{
					description: "LSP operation to execute",
				},
			),
			filePath: Type.String({ description: "Absolute or relative file path" }),
			line: Type.Optional(Type.Number({ description: "1-based line (required for definition/references/hover)" })),
			character: Type.Optional(
				Type.Number({ description: "1-based character (required for definition/references/hover)" }),
			),
			query: Type.Optional(Type.String({ description: "Search query for workspaceSymbol" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const op = params.operation as LspOperation;
			if (operationNeedsPosition(op) && (params.line === undefined || params.character === undefined)) {
				throw new Error(`Operation ${op} requires line and character.`);
			}

			const filePath = normalizePath(params.filePath, ctx.cwd);
			if (!fs.existsSync(filePath)) {
				throw new Error(`File not found: ${filePath}`);
			}

			lastUiContext = ctx;
			const activeClients = await getClientsForFile(filePath, ctx.cwd, ctx);
			if (activeClients.length === 0) {
				throw new Error("No LSP server available for this file type/environment.");
			}

			const results: Array<{ server: string; result: unknown }> = [];
			for (const client of activeClients) {
				await client.touchFile(filePath);
				const result = await client.call(op, {
					filePath,
					line: params.line,
					character: params.character,
					query: params.query,
				});
				results.push({ server: client.serverId, result });
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(results, null, 2),
					},
				],
				details: {
					operation: op,
					filePath,
					servers: activeClients.map((client) => client.serverId),
					resultCount: results.length,
				},
			};
		},
	});

	pi.registerCommand("lsp-status", {
		description: "Show currently active LSP clients started by this extension",
		handler: async (_args, ctx) => {
			lastUiContext = ctx;
			updateStatus(ctx);
			if (clients.size === 0) {
				ctx.ui.notify("No active LSP clients.", "info");
				return;
			}
			const lines = Array.from(clients.values()).map((client) => `${client.serverId} @ ${client.root}`);
			pi.sendMessage({ customType: "lsp-status", content: lines.join("\n"), display: true }, { triggerTurn: false });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastUiContext = ctx;
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastUiContext = ctx;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const client of clients.values()) {
			client.shutdown();
		}
		clients.clear();
		updateStatus();
	});
}
