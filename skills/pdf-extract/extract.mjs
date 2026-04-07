#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const DEFAULT_MODEL = 'gemini-2.5-flash';
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

function getAccessToken() {
  try {
    return execSync('gcloud auth application-default print-access-token', { encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error(`Failed to get access token: ${e.message}\nRun: gcloud auth application-default login`);
  }
}

function buildPdfPart(input) {
  if (input.startsWith('gs://')) {
    return { fileData: { fileUri: input, mimeType: 'application/pdf' } };
  }
  const resolved = resolve(input);
  if (!existsSync(resolved)) throw new Error(`Local file not found: ${resolved}`);
  return { inlineData: { data: readFileSync(resolved).toString('base64'), mimeType: 'application/pdf' } };
}

async function extractTextFromPdf(project, location, model, input) {
  const token = getAccessToken();
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [buildPdfPart(input), { text: PROMPT }] }],
      generationConfig: { temperature: 0 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Vertex AI request failed (${response.status}): ${await response.text()}`);
  }

  const json = await response.json();
  return json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
}

function parseArgs(argv) {
  const out = { input: undefined, output: undefined, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--output' || argv[i] === '-o') && argv[i + 1]) {
      out.output = argv[++i];
    } else if ((argv[i] === '--model' || argv[i] === '-m') && argv[i + 1]) {
      out.model = argv[++i];
    } else if (!out.input) {
      out.input = argv[i];
    }
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

  if (!project) {
    console.error('Error: GOOGLE_CLOUD_PROJECT environment variable is not set.');
    process.exit(1);
  }

  try {
    const text = await extractTextFromPdf(project, location, args.model, args.input);
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
