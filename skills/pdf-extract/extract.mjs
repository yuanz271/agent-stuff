#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createSign } from 'crypto';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';
const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const PROMPT = `\
Convert this PDF document into well-structured markdown, faithfully and completely, \
preserving the original reading order (column by column, top to bottom).

Rules:
- Use # / ## / ### for section headings matching the original hierarchy.
- Preserve bold and italic formatting.
- Render all equations in LaTeX: inline as $...$ and display as $$...$$
- Render tables as markdown tables.
- Preserve figure captions and footnotes.
- Omit page numbers, running headers, footers, and line numbers.
- No commentary, preamble, or explanation — output only the converted document.`;

// ── Auth (service account JWT, same pattern as websearch extension) ────────

let cachedToken = null;
let cachedCredentials = null;

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwtRS256(unsignedJwt, privateKeyPem) {
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  return signer.sign(privateKeyPem).toString('base64url');
}

function loadServiceAccountCredentials(credentialsPath) {
  if (cachedCredentials) return cachedCredentials;
  const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  if (parsed.type !== 'service_account') {
    throw new Error(`Invalid credentials type: expected service_account, got ${parsed.type ?? 'unknown'}`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Invalid service account JSON: missing client_email or private_key');
  }
  cachedCredentials = parsed;
  return cachedCredentials;
}

async function getAccessToken(credentialsPath) {
  const nowMs = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - nowMs > 60_000) return cachedToken.token;

  const creds = loadServiceAccountCredentials(credentialsPath);
  const tokenUri = creds.token_uri ?? DEFAULT_TOKEN_URI;
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;

  const unsignedJwt = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(
    JSON.stringify({ iss: creds.client_email, scope: GOOGLE_OAUTH_SCOPE, aud: tokenUri, iat, exp }),
  )}`;
  const assertion = `${unsignedJwt}.${signJwtRS256(unsignedJwt, creds.private_key)}`;

  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!resp.ok) throw new Error(`OAuth token request failed (${resp.status}): ${await resp.text()}`);

  const json = await resp.json();
  if (!json.access_token) throw new Error('OAuth token response missing access_token');
  cachedToken = { token: json.access_token, expiresAtMs: nowMs + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

// ── PDF extraction ─────────────────────────────────────────────────────────

function buildPdfPart(input) {
  if (input.startsWith('gs://')) {
    return { fileData: { fileUri: input, mimeType: 'application/pdf' } };
  }
  const resolved = resolve(input);
  if (!existsSync(resolved)) throw new Error(`Local file not found: ${resolved}`);
  return { inlineData: { data: readFileSync(resolved).toString('base64'), mimeType: 'application/pdf' } };
}

async function extractTextFromPdf(project, location, model, credentialsPath, input) {
  const token = await getAccessToken(credentialsPath);
  const normalizedLocation = location.trim().toLowerCase();
  const endpoint = normalizedLocation === 'global'
    ? `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`
    : `https://${normalizedLocation}-aiplatform.googleapis.com/v1/projects/${project}/locations/${normalizedLocation}/publishers/google/models/${model}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [buildPdfPart(input), { text: PROMPT }] }],
      generationConfig: { temperature: 0 },
    }),
  });

  if (!response.ok) throw new Error(`Vertex AI request failed (${response.status}): ${await response.text()}`);

  const json = await response.json();
  const candidate = json.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    throw new Error(`Model stopped with finishReason: ${finishReason}`);
  }
  const text = candidate?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!text) throw new Error('Model returned empty response');
  return text;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { input: undefined, output: undefined, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--output' || argv[i] === '-o') && argv[i + 1]) out.output = argv[++i];
    else if ((argv[i] === '--model' || argv[i] === '-m') && argv[i + 1]) out.model = argv[++i];
    else if (!out.input) out.input = argv[i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error('Usage: node extract.mjs <local-pdf-path | gs://bucket/file.pdf> [--output <path>] [--model <model-id>]');
    process.exit(1);
  }

  const project = process.env['GOOGLE_CLOUD_PROJECT'];
  const location = process.env['GOOGLE_CLOUD_LOCATION'] ?? 'us-central1';
  const credentialsPath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];

  if (!project) { console.error('Error: GOOGLE_CLOUD_PROJECT is not set.'); process.exit(1); }
  if (!credentialsPath) { console.error('Error: GOOGLE_APPLICATION_CREDENTIALS is not set.'); process.exit(1); }

  try {
    const text = await extractTextFromPdf(project, location, args.model, credentialsPath, args.input);
    if (args.output) {
      writeFileSync(resolve(args.output), text, 'utf8');
      console.error(`Written to ${args.output}`);
    } else {
      process.stdout.write(text);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

main();
