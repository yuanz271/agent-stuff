---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs."
---

# Native Web Search

Use this skill to run a **fast model with native web search enabled** and get a concise research summary with explicit full URLs.

## Script

- `search.mjs`

## Usage

Run from this skill directory:

```bash
node search.mjs "<what to search>" --purpose "<why you need this>"
```

Examples:

```bash
node search.mjs "latest python release" --purpose "update dependency notes"
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
```

Optional flags:

- `--provider openai|openai-codex|anthropic|gemini|gemini-cli` (Gemini API is opt-in; `gemini-cli` uses local CLI with Vertex AI auth — no API key needed)
- `--model <model-id>`
- `--timeout <ms>`
- `--json`
- `--debug` (print transport/proxy/connectivity diagnostics to stderr)

## Output expectations

The script instructs the model to:
- search the internet for the requested topic
- provide a concise summary for the given purpose
- include full canonical URLs (`https://...`) for each key finding
- highlight disagreements between sources

## Notes

- No extra npm install is required.
- Authentication is environment-variable based (no pi settings/auth files):
  - `OPENAI_API_KEY` for `openai`
  - `ANTHROPIC_API_KEY` for `anthropic`
  - `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) for `gemini` (only when explicitly selected)
  - `CODEX_API_KEY` (or `OPENAI_API_KEY`) for `openai-codex` (optional `CHATGPT_ACCOUNT_ID`)
  - **No key needed** for `gemini-cli` — uses local `gemini` CLI with existing Vertex AI / Google auth
- Auto-selection order: `gemini-cli` (if installed) → `openai` → `anthropic` → `openai-codex` → `gemini` (API)
- If module resolution fails, set `PI_AI_MODULE_PATH` to `@mariozechner/pi-ai`'s `dist/index.js` path.
- If OAuth helper resolution fails, set `PI_AI_OAUTH_MODULE_PATH` to `@mariozechner/pi-ai`'s `dist/oauth.js` path.
- For OAuth providers, the script can fall back to a still-valid cached `access` token from `~/.pi/agent/auth.json`.

## Sandbox/Proxy troubleshooting

If requests fail with `fetch failed` under sandbox mode:

1. Run with diagnostics:
   ```bash
   node search.mjs "<query>" --provider anthropic --debug --json
   ```
2. Ensure sandbox `allowedDomains` includes your provider endpoint domain.
3. Check proxy env variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`).
4. If needed, run the session with `--no-sandbox` for web research commands.
