#!/usr/bin/env node

import { VertexAI } from '@google-cloud/vertexai';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const MODEL = 'gemini-2.5-flash';
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

function buildPdfPart(input) {
  if (input.startsWith('gs://')) {
    return {
      fileData: {
        fileUri: input,
        mimeType: 'application/pdf',
      },
    };
  }

  const resolved = resolve(input);
  if (!existsSync(resolved)) {
    throw new Error(`Local file not found: ${resolved}`);
  }
  return {
    inlineData: {
      data: readFileSync(resolved).toString('base64'),
      mimeType: 'application/pdf',
    },
  };
}

async function extractTextFromPdf(project, location, input) {
  const vertexAI = new VertexAI({ project, location });
  const model = vertexAI.getGenerativeModel({ model: MODEL });

  const request = {
    contents: [
      {
        role: 'user',
        parts: [buildPdfPart(input), { text: PROMPT }],
      },
    ],
  };

  const responseStream = await model.generateContentStream(request);

  let fullText = '';
  for await (const item of responseStream.stream) {
    const text = item?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) fullText += text;
  }
  return fullText;
}

function parseArgs(argv) {
  const out = { input: undefined, output: undefined };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--output' || argv[i] === '-o') && argv[i + 1]) {
      out.output = argv[++i];
    } else if (!out.input) {
      out.input = argv[i];
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error('Usage: node extract.mjs <local-pdf-path | gs://bucket/file.pdf> [--output <path>]');
    process.exit(1);
  }

  const project = process.env['GOOGLE_CLOUD_PROJECT'];
  const location = process.env['GOOGLE_CLOUD_LOCATION'] ?? 'us-central1';

  if (!project) {
    console.error('Error: GOOGLE_CLOUD_PROJECT environment variable is not set.');
    process.exit(1);
  }

  try {
    const text = await extractTextFromPdf(project, location, args.input);
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
