#!/usr/bin/env node

import { existsSync, realpathSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

function parseArgs(argv) {
	const out = {
		provider: undefined,
		model: undefined,
		purpose: "general research support",
		timeoutMs: 120000,
		json: false,
		help: false,
		debug: false,
		query: "",
	};

	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") { out.help = true; continue; }
		if (arg === "--json") { out.json = true; continue; }
		if (arg === "--debug") { out.debug = true; continue; }
		if (arg === "--provider") { out.provider = argv[++i]; continue; }
		if (arg.startsWith("--provider=")) { out.provider = arg.slice("--provider=".length); continue; }
		if (arg === "--model") { out.model = argv[++i]; continue; }
		if (arg.startsWith("--model=")) { out.model = arg.slice("--model=".length); continue; }
		if (arg === "--purpose") { out.purpose = argv[++i] || out.purpose; continue; }
		if (arg.startsWith("--purpose=")) { out.purpose = arg.slice("--purpose=".length) || out.purpose; continue; }
		if (arg === "--timeout") { out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs)); continue; }
		if (arg.startsWith("--timeout=")) { out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs)); continue; }
		positional.push(arg);
	}

	out.query = positional.join(" ").trim();
	return out;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider openai|openai-codex|anthropic|gemini|gemini-cli] [--model <id>] [--json] [--debug]

Auth (env vars):
  openai:       OPENAI_API_KEY
  anthropic:    ANTHROPIC_API_KEY
  gemini:       GEMINI_API_KEY (or GOOGLE_API_KEY)
  openai-codex: CODEX_API_KEY (or OPENAI_API_KEY), optional CHATGPT_ACCOUNT_ID
  gemini-cli:   no API key needed (uses local gemini CLI with Vertex AI / Google auth)

Examples:
  node search.mjs "latest python release" --provider gemini-cli
  OPENAI_API_KEY=... node search.mjs "latest python release" --provider openai
  ANTHROPIC_API_KEY=... node search.mjs "HTTP/3 browser support 2026" --provider anthropic
  GEMINI_API_KEY=... node search.mjs "vite 7 breaking changes" --provider gemini --json`;
}

function normalizeProvider(provider) {
	if (!provider) return undefined;
	const p = String(provider).toLowerCase().trim();
	if (p === "gemini-cli") return "gemini-cli";
	if (p === "openai" || p === "openai-api") return "openai";
	if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
	if (p.includes("gemini") || p.includes("google")) return "gemini";
	if (p.includes("codex") || p === "openai-codex") return "openai-codex";
	return undefined;
}

function isGeminiCliAvailable() {
	const result = spawnSync("gemini", ["--version"], { encoding: "utf8", timeout: 5000 });
	return result.status === 0;
}

function pickProvider(argProvider) {
	const forced = normalizeProvider(argProvider);
	if (forced) return forced;

	// Prefer gemini-cli first (no API key needed, uses local Vertex AI auth).
	if (isGeminiCliAvailable()) return "gemini-cli";

	if (process.env.OPENAI_API_KEY) return "openai";
	if (process.env.ANTHROPIC_API_KEY) return "anthropic";
	if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
	if (process.env.CODEX_API_KEY) return "openai-codex";

	throw new Error("Could not determine provider. Pass --provider or set an API key env var.");
}

function resolveApiKey(provider) {
	if (provider === "gemini-cli") return { apiKey: "__cli__" };

	if (provider === "openai") {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("Missing OPENAI_API_KEY.");
		return { apiKey };
	}
	if (provider === "anthropic") {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY.");
		return { apiKey };
	}
	if (provider === "gemini") {
		const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
		if (!apiKey) throw new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY).");
		return { apiKey };
	}
	if (provider === "openai-codex") {
		const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("Missing CODEX_API_KEY or OPENAI_API_KEY.");
		return { apiKey, accountId: process.env.CHATGPT_ACCOUNT_ID };
	}

	throw new Error(`Unknown provider: ${provider}`);
}

function decodeJwtAccountId(jwt) {
	if (!jwt || typeof jwt !== "string") return undefined;
	try {
		const parts = jwt.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function findPiExecutable() {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	return result.stdout.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
}

function collectModuleCandidates() {
	const candidates = new Set();
	const add = (p) => {
		if (!p) return;
		candidates.add(isAbsolute(p) ? p : resolve(p));
	};

	if (process.env.PI_AI_MODULE_PATH) add(process.env.PI_AI_MODULE_PATH);

	const cwd = process.cwd();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	for (const start of [cwd, scriptDir]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			add(join(dir, "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"));
			add(join(dir, "packages", "ai", "dist", "index.js"));
			add(join(dir, "ai", "dist", "index.js"));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const piExec = findPiExecutable();
	if (piExec) {
		try {
			const piDir = dirname(realpathSync(piExec));
			add(join(piDir, "..", "..", "ai", "dist", "index.js"));
			add(join(piDir, "..", "..", "pi-ai", "dist", "index.js"));
			add(join(piDir, "..", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"));
			add(join(piDir, "..", "..", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"));
		} catch { /* ignore */ }
	}

	add(join(homedir(), "Development", "pi-mono", "packages", "ai", "dist", "index.js"));
	return Array.from(candidates);
}

async function loadPiAi() {
	const tried = [];

	try {
		return await import("@mariozechner/pi-ai");
	} catch (err) {
		tried.push(`@mariozechner/pi-ai (${err?.code || err?.message || "not found"})`);
	}

	for (const candidate of collectModuleCandidates()) {
		if (!existsSync(candidate)) continue;
		try {
			return await import(pathToFileURL(candidate).href);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	throw new Error(
		`Could not load @mariozechner/pi-ai. Set PI_AI_MODULE_PATH to its dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
	);
}

function pickFastModel(provider, requestedModel, piAi) {
	const models = typeof piAi.getModels === "function" ? piAi.getModels(provider) : [];
	if (!Array.isArray(models) || models.length === 0) {
		if (requestedModel) return { id: requestedModel, baseUrl: undefined };
		if (provider === "openai-codex") return { id: "gpt-5.1-codex-mini", baseUrl: "https://chatgpt.com/backend-api" };
		if (provider === "openai") return { id: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1" };
		if (provider === "gemini") return { id: "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
		if (provider === "gemini-cli") return { id: "gemini-2.5-flash", baseUrl: undefined };
		return { id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com" };
	}

	if (requestedModel) {
		const exact = models.find((m) => m.id === requestedModel);
		return exact ?? { ...models[0], id: requestedModel };
	}

	const preferredIds =
		provider === "openai-codex" ? ["gpt-5.1-codex-mini", "gpt-5.3-codex-spark", "gpt-5.1"] :
		provider === "openai" ? ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1"] :
		provider === "gemini" || provider === "gemini-cli" ? ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"] :
		["claude-haiku-4-5", "claude-3-5-haiku-latest", "claude-3-5-haiku-20241022"];

	for (const id of preferredIds) {
		const found = models.find((m) => m.id === id);
		if (found) return found;
	}

	return models.find((m) => /mini|haiku|spark|flash|fast/i.test(m.id)) ?? models[0];
}

function buildUserPrompt(query, purpose, currentYear) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\nCurrent year: ${currentYear}\n\nAssume the current year is ${currentYear}. Do not default to earlier years. If you reference information from a prior year, explicitly label it as prior-year.\nPrioritize the latest available sources and updates (newest first when possible).\nIf a source appears outdated relative to ${currentYear}, explicitly label it as potentially stale.\nPrioritize web-search tool results as-is; avoid over-interpretation beyond cited pages.\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- include publication/update year for each finding when available\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
	return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api") {
	const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function hasProxyEnv() {
	return Boolean(
		process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY ||
		process.env.http_proxy || process.env.https_proxy || process.env.all_proxy,
	);
}

function formatProxyEnvForDiag() {
	const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
	const out = {};
	for (const key of keys) {
		const value = process.env[key];
		if (value) out[key] = value.replace(/:\/\/([^:@/]+):([^@/]+)@/g, "://$1:***@");
	}
	return out;
}

function normalizeFetchError(err) {
	return {
		message: err?.message || String(err),
		code: err?.cause?.code || err?.code,
		cause: err?.cause?.message,
	};
}

function shouldTryCurlFallback(err) {
	const code = err?.cause?.code || err?.code || "";
	if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT"].includes(code)) return true;
	const msg = String(err?.message || "").toLowerCase();
	return msg.includes("fetch failed") || msg.includes("network");
}

function runCurlRequest(url, { method = "GET", headers = {}, body, timeoutMs = 120000 }) {
	const args = ["-sS", "-L", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "-X", method];
	for (const [key, value] of Object.entries(headers || {})) {
		if (value != null) args.push("-H", `${key}: ${value}`);
	}
	if (body !== undefined) args.push("--data-binary", body);
	args.push(url, "-w", "\n__CURL_STATUS__:%{http_code}");

	const res = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: process.env });
	if (res.error) throw res.error;
	if (res.status !== 0) throw new Error(`curl failed (${res.status}): ${(res.stderr || res.stdout || "").trim()}`);

	const out = res.stdout || "";
	const marker = "\n__CURL_STATUS__:";
	const idx = out.lastIndexOf(marker);
	if (idx === -1) throw new Error("curl output parse failed");
	const text = out.slice(0, idx);
	const status = Number(out.slice(idx + marker.length).trim());
	if (!Number.isFinite(status)) throw new Error("curl returned invalid status code");
	return { status, ok: status >= 200 && status < 300, text, transport: "curl" };
}

async function requestTextWithFallback(url, { method = "GET", headers = {}, body, timeoutMs = 120000, debug = false } = {}) {
	const signal = AbortSignal?.timeout?.(timeoutMs);
	try {
		const res = await fetch(url, { method, headers, body, signal });
		return { status: res.status, ok: res.ok, text: await res.text(), transport: "fetch" };
	} catch (err) {
		if (!shouldTryCurlFallback(err)) throw err;
		if (debug) {
			const info = normalizeFetchError(err);
			console.error(`[debug] fetch failed (${info.code || "no-code"}): ${info.message}${info.cause ? ` | cause: ${info.cause}` : ""}`);
		}
		if (!hasProxyEnv()) throw err;
		return runCurlRequest(url, { method, headers, body, timeoutMs });
	}
}

function extractEventData(chunk) {
	const payload = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!payload || payload === "[DONE]") return null;
	return payload;
}

async function runCodexSearch({ model, apiKey, accountId, query, purpose, timeoutMs, baseUrl }) {
	const tokenAccountId = accountId || decodeJwtAccountId(apiKey);
	if (!tokenAccountId) throw new Error("Could not determine ChatGPT account ID for openai-codex token.");

	const endpoint = resolveCodexUrl(baseUrl);
	const signal = AbortSignal?.timeout?.(timeoutMs);

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"chatgpt-account-id": tokenAccountId,
			"content-type": "application/json",
			accept: "text/event-stream",
			"OpenAI-Beta": "responses=experimental",
			originator: "pi-native-web-search-skill",
		},
		body: JSON.stringify({
			model, store: false, stream: true,
			instructions: buildSystemPrompt(),
			input: [{ role: "user", content: buildUserPrompt(query, purpose, new Date().getFullYear()) }],
			tools: [{ type: "web_search" }],
			tool_choice: "auto",
		}),
		signal,
	});

	if (!res.ok) throw new Error(`Codex request failed (${res.status}): ${await res.text()}`);
	if (!res.body) throw new Error("Codex response had no body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "", text = "", fallbackText = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			idx = buffer.indexOf("\n\n");

			const data = extractEventData(chunk);
			if (!data) continue;
			let event;
			try { event = JSON.parse(data); } catch { continue; }

			if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
			if (event.type === "response.output_item.done" && event.item?.type === "message") {
				const full = (event.item?.content || []).filter((p) => p.type === "output_text").map((p) => p.text).join("\n");
				if (full) fallbackText = full;
			}
			if (event.type === "error") throw new Error(event.message || "Codex stream failed");
			if (event.type === "response.failed") throw new Error(event.response?.error?.message || "Codex response failed");
		}
	}

	const finalText = (text || fallbackText || "").trim();
	if (!finalText) throw new Error("Codex returned an empty response");
	return finalText;
}

async function runOpenAISearch({ model, apiKey, query, purpose, timeoutMs, baseUrl, debug = false }) {
	const base = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
	const response = await requestTextWithFallback(`${base}/responses`, {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			model, store: false,
			instructions: buildSystemPrompt(),
			input: [{ role: "user", content: buildUserPrompt(query, purpose, new Date().getFullYear()) }],
			tools: [{ type: "web_search_preview" }],
			tool_choice: "auto",
		}),
		timeoutMs, debug,
	});

	if (!response.ok) throw new Error(`OpenAI request failed (${response.status}) via ${response.transport}: ${response.text}`);

	let parsed;
	try { parsed = JSON.parse(response.text); } catch { throw new Error("OpenAI returned non-JSON response"); }

	const text = (parsed.output || [])
		.filter((item) => item.type === "message")
		.flatMap((item) => item.content || [])
		.filter((part) => part.type === "output_text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n\n").trim();

	if (!text) throw new Error("OpenAI returned no text content");
	return text;
}

async function runAnthropicSearch({ model, apiKey, query, purpose, timeoutMs, debug = false }) {
	const response = await requestTextWithFallback("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "web-search-2025-03-05",
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({
			model, max_tokens: 1800, temperature: 0,
			system: buildSystemPrompt(),
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
			messages: [{ role: "user", content: buildUserPrompt(query, purpose, new Date().getFullYear()) }],
		}),
		timeoutMs, debug,
	});

	if (!response.ok) throw new Error(`Anthropic request failed (${response.status}) via ${response.transport}: ${response.text}`);

	let parsed;
	try { parsed = JSON.parse(response.text); } catch { throw new Error("Anthropic returned non-JSON response"); }

	const text = (parsed.content || [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n\n").trim();

	if (!text) throw new Error("Anthropic returned no text content");
	return text;
}

async function runGeminiSearch({ model, apiKey, query, purpose, timeoutMs, baseUrl, debug = false }) {
	const base = String(baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
	const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

	const response = await requestTextWithFallback(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
			contents: [{ role: "user", parts: [{ text: buildUserPrompt(query, purpose, new Date().getFullYear()) }] }],
			tools: [{ google_search: {} }],
		}),
		timeoutMs, debug,
	});

	if (!response.ok) throw new Error(`Gemini request failed (${response.status}) via ${response.transport}: ${response.text}`);

	let parsed;
	try { parsed = JSON.parse(response.text); } catch { throw new Error("Gemini returned non-JSON response"); }

	const text = (parsed.candidates || [])
		.flatMap((c) => c?.content?.parts || [])
		.filter((part) => typeof part?.text === "string")
		.map((part) => part.text)
		.join("\n\n").trim();

	if (!text) throw new Error("Gemini returned no text content");
	return text;
}

async function runGeminiCliSearch({ model, query, purpose, timeoutMs, debug = false }) {
	const prompt = `${buildSystemPrompt()}\n\n${buildUserPrompt(query, purpose, new Date().getFullYear())}`;
	const args = ["-p", prompt, "--approval-mode", "yolo", "-o", "text"];
	if (model) args.push("-m", model);

	if (debug) console.error(`[debug] gemini-cli args: gemini ${args.map((a) => JSON.stringify(a)).join(" ")}`);

	const result = spawnSync("gemini", args, {
		encoding: "utf8",
		timeout: timeoutMs + 5000,
		maxBuffer: 10 * 1024 * 1024,
		env: { ...process.env, GEMINI_CLI_TIMEOUT: String(Math.max(10, Math.ceil(timeoutMs / 1000))) },
	});

	if (result.error) throw new Error(`gemini-cli spawn failed: ${result.error.message}`);

	const stdout = (result.stdout || "")
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("YOLO mode is enabled"))
		.join("\n").trim();

	if (result.status !== 0) {
		const stderr = (result.stderr || "").trim();
		throw new Error(`gemini-cli exited ${result.status}: ${stderr || stdout || "(no output)"}`);
	}
	if (!stdout) throw new Error("gemini-cli returned empty output");
	return stdout;
}

function resolveEndpointForDiag(provider, model) {
	if (provider === "gemini-cli") return "gemini-cli (local)";
	if (provider === "openai-codex") return resolveCodexUrl(model.baseUrl);
	if (provider === "openai") return `${String(model.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
	if (provider === "gemini") {
		const base = String(model.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
		return `${base}/models/${encodeURIComponent(model.id)}:generateContent`;
	}
	return "https://api.anthropic.com/v1/messages";
}

async function runConnectivityProbe(url, timeoutMs) {
	const response = await requestTextWithFallback(url, {
		method: "GET",
		headers: { accept: "application/json" },
		timeoutMs: Math.min(timeoutMs, 8000),
	});
	return { status: response.status, ok: response.ok, transport: response.transport };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const provider = pickProvider(args.provider);
	const piAi = await loadPiAi();
	const model = pickFastModel(provider, args.model, piAi);
	const { apiKey, accountId } = resolveApiKey(provider);
	const endpoint = resolveEndpointForDiag(provider, model);

	if (args.debug) {
		const debugInfo = { provider, model: model.id, endpoint, hasProxyEnv: hasProxyEnv(), proxyEnv: formatProxyEnvForDiag() };
		console.error(args.json ? JSON.stringify({ debug: debugInfo }, null, 2) : `[debug] ${JSON.stringify(debugInfo, null, 2)}`);
		if (provider !== "gemini-cli") {
			try {
				const probe = await runConnectivityProbe(endpoint, args.timeoutMs);
				console.error(args.json ? JSON.stringify({ probe }, null, 2) : `[debug] probe ${probe.ok ? "ok" : "not-ok"}: status=${probe.status} transport=${probe.transport}`);
			} catch (err) {
				const info = normalizeFetchError(err);
				console.error(args.json ? JSON.stringify({ probeError: info }, null, 2) : `[debug] probe failed: ${info.code || "no-code"} ${info.message}`);
			}
		}
	}

	let text;
	if (provider === "gemini-cli") {
		text = await runGeminiCliSearch({ model: args.model, query: args.query, purpose: args.purpose, timeoutMs: args.timeoutMs, debug: args.debug });
	} else if (provider === "openai-codex") {
		text = await runCodexSearch({ model: model.id, apiKey, accountId, query: args.query, purpose: args.purpose, timeoutMs: args.timeoutMs, baseUrl: model.baseUrl });
	} else if (provider === "openai") {
		text = await runOpenAISearch({ model: model.id, apiKey, query: args.query, purpose: args.purpose, timeoutMs: args.timeoutMs, baseUrl: model.baseUrl, debug: args.debug });
	} else if (provider === "gemini") {
		text = await runGeminiSearch({ model: model.id, apiKey, query: args.query, purpose: args.purpose, timeoutMs: args.timeoutMs, baseUrl: model.baseUrl, debug: args.debug });
	} else {
		text = await runAnthropicSearch({ model: model.id, apiKey, query: args.query, purpose: args.purpose, timeoutMs: args.timeoutMs, debug: args.debug });
	}

	if (args.json) {
		console.log(JSON.stringify({ provider, model: model.id, query: args.query, purpose: args.purpose, endpoint, result: text }, null, 2));
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(`Model: ${model.id}`);
	console.log("");
	console.log(text);
}

main().catch((err) => {
	const info = normalizeFetchError(err);
	console.error(info.code || info.cause
		? `Error: ${info.message} (${info.code || "no-code"}${info.cause ? `; cause: ${info.cause}` : ""})`
		: `Error: ${info.message}`);
	process.exit(1);
});
