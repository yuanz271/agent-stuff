import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createSign } from "node:crypto";
import { promises as fs } from "node:fs";

type GroundingSupport = {
  segment?: {
    partIndex?: number;
    startIndex?: number;
    endIndex?: number;
    text?: string;
  };
  groundingChunkIndices?: number[];
  confidenceScores?: number[];
};

type GroundingMetadata = {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  groundingSupports?: GroundingSupport[];
};

type VertexResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: GroundingMetadata;
  }>;
};

type ServiceAccountCredentials = {
  type: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
};

type WebsearchConfig = {
  project: string;
  location: string;
  credentialsPath: string;
};

type WebsearchSource = {
  title: string;
  url: string;
  domain: string;
  isGroundingRedirect: boolean;
  groundingUrl?: string;
};

type ChunkSourceRecord = {
  chunkIndex: number;
  source: WebsearchSource;
};

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_SOURCES = 8;
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const GROUNDING_REDIRECT_PATH_SEGMENT = "grounding-api-redirect";
const REQUIRED_ENV = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
] as const;

let cachedToken: { token: string; expiresAtMs: number } | null = null;
let cachedCredentials: ServiceAccountCredentials | null = null;
const cachedResolvedGroundingUrls = new Map<string, string>();

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getConfigFromEnv(): { config?: WebsearchConfig; missing: string[] } {
  const missing = REQUIRED_ENV.filter((name) => !env(name));
  if (missing.length > 0) return { missing };
  return {
    missing,
    config: {
      credentialsPath: env("GOOGLE_APPLICATION_CREDENTIALS")!,
      project: env("GOOGLE_CLOUD_PROJECT")!,
      location: env("GOOGLE_CLOUD_LOCATION")!,
    },
  };
}

function buildVertexEndpoint(project: string, location: string, model: string): string {
  const normalizedLocation = location.trim().toLowerCase();
  if (normalizedLocation === "global") {
    return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`;
  }
  return `https://${normalizedLocation}-aiplatform.googleapis.com/v1/projects/${project}/locations/${normalizedLocation}/publishers/google/models/${model}:generateContent`;
}

function extractTextParts(resp: VertexResponse): string[] {
  return resp.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "") ?? [];
}

function joinTextParts(parts: string[]): string {
  return parts.join("\n").trim();
}

function getUrlDomain(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function isGroundingRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === GROUNDING_REDIRECT_HOST && parsed.pathname.includes(GROUNDING_REDIRECT_PATH_SEGMENT);
  } catch {
    return false;
  }
}

function normalizeRedirectLocation(location: string, baseUrl: string): string {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location.trim();
  }
}

function discardResponseBody(response: Response): void {
  if (response.body) {
    void response.body.cancel().catch(() => {});
  }
}

async function resolveGroundingRedirectUrl(url: string, signal?: AbortSignal): Promise<string> {
  const cached = cachedResolvedGroundingUrls.get(url);
  if (cached) return cached;

  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal,
    });
    const location = head.headers.get("location")?.trim();
    if (location) {
      const resolved = normalizeRedirectLocation(location, url);
      cachedResolvedGroundingUrls.set(url, resolved);
      return resolved;
    }
  } catch {
    // Fall through to GET-based resolution.
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal,
    });
    const resolved = response.url?.trim();
    discardResponseBody(response);
    if (resolved) {
      cachedResolvedGroundingUrls.set(url, resolved);
      return resolved;
    }
  } catch {
    // Return the original redirect URL if resolution fails.
  }

  return url;
}

function extractChunkSourceRecords(resp: VertexResponse): ChunkSourceRecord[] {
  const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const out: ChunkSourceRecord[] = [];

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const url = chunk.web?.uri?.replace(/\s+/g, "").trim();
    if (!url) continue;

    out.push({
      chunkIndex,
      source: {
        title: chunk.web?.title?.trim() || url,
        url,
        domain: getUrlDomain(url),
        isGroundingRedirect: isGroundingRedirectUrl(url),
      },
    });
  }

  return out;
}

function extractCitedChunkIndices(supports: GroundingSupport[] | undefined): Set<number> {
  const citedChunkIndices = new Set<number>();
  for (const support of supports ?? []) {
    for (const chunkIndex of support.groundingChunkIndices ?? []) {
      if (Number.isInteger(chunkIndex) && chunkIndex >= 0) citedChunkIndices.add(chunkIndex);
    }
  }
  return citedChunkIndices;
}

function selectChunkSourceRecords(
  records: ChunkSourceRecord[],
  citedChunkIndices: Set<number>,
  maxSources: number,
): { selectedRecords: ChunkSourceRecord[]; hasCitedSources: boolean } {
  const hasCitedSources = citedChunkIndices.size > 0;
  const selectedRawUrls = new Set<string>();

  if (hasCitedSources) {
    for (const { chunkIndex, source } of records) {
      if (citedChunkIndices.has(chunkIndex)) selectedRawUrls.add(source.url);
    }
  } else {
    for (const { source } of records) {
      if (selectedRawUrls.has(source.url)) continue;
      selectedRawUrls.add(source.url);
      if (selectedRawUrls.size >= maxSources) break;
    }
  }

  return {
    selectedRecords: records.filter(({ source }) => selectedRawUrls.has(source.url)),
    hasCitedSources,
  };
}

async function resolveChunkSourceRecords(records: ChunkSourceRecord[], signal?: AbortSignal): Promise<ChunkSourceRecord[]> {
  return Promise.all(
    records.map(async ({ chunkIndex, source }) => {
      if (!source.isGroundingRedirect) return { chunkIndex, source };

      const resolvedUrl = await resolveGroundingRedirectUrl(source.url, signal);
      return {
        chunkIndex,
        source: {
          ...source,
          url: resolvedUrl,
          domain: getUrlDomain(resolvedUrl),
          groundingUrl: source.url,
        },
      };
    }),
  );
}

function buildVisibleSources(records: ChunkSourceRecord[]): { sources: WebsearchSource[]; chunkIndexToSourceNumber: Map<number, number> } {
  const sources: WebsearchSource[] = [];
  const chunkIndexToSourceNumber = new Map<number, number>();
  const sourceNumberByUrl = new Map<string, number>();

  for (const { chunkIndex, source } of records) {
    let sourceNumber = sourceNumberByUrl.get(source.url);
    if (sourceNumber === undefined) {
      sourceNumber = sources.length + 1;
      sourceNumberByUrl.set(source.url, sourceNumber);
      sources.push(source);
    }
    chunkIndexToSourceNumber.set(chunkIndex, sourceNumber);
  }

  return { sources, chunkIndexToSourceNumber };
}

function utf8ByteOffsetToStringIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;

  let currentByteOffset = 0;
  let currentStringIndex = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    const nextByteOffset = currentByteOffset + charBytes;
    if (nextByteOffset > byteOffset) return currentStringIndex;
    currentByteOffset = nextByteOffset;
    currentStringIndex += char.length;
    if (currentByteOffset === byteOffset) return currentStringIndex;
  }

  return text.length;
}

function addInlineCitations(
  parts: string[],
  supports: GroundingSupport[] | undefined,
  chunkIndexToSourceNumber: Map<number, number>,
): { text: string; hasInlineCitations: boolean } {
  if (!supports?.length) {
    return { text: joinTextParts(parts), hasInlineCitations: false };
  }

  const updatedParts = [...parts];
  let hasInlineCitations = false;
  const citationsByPart = new Map<number, Map<number, Set<number>>>();

  for (const support of supports) {
    const partIndex = support.segment?.partIndex ?? 0;
    const endIndex = support.segment?.endIndex;
    if (endIndex === undefined || endIndex < 0) continue;

    const sourceNumbers = [...new Set((support.groundingChunkIndices ?? [])
      .map((chunkIndex) => chunkIndexToSourceNumber.get(chunkIndex))
      .filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
    if (sourceNumbers.length === 0) continue;

    let partCitations = citationsByPart.get(partIndex);
    if (!partCitations) {
      partCitations = new Map<number, Set<number>>();
      citationsByPart.set(partIndex, partCitations);
    }

    const existing = partCitations.get(endIndex) ?? new Set<number>();
    for (const sourceNumber of sourceNumbers) existing.add(sourceNumber);
    partCitations.set(endIndex, existing);
  }

  for (const [partIndex, partCitations] of citationsByPart) {
    const originalPart = updatedParts[partIndex];
    if (originalPart === undefined) continue;

    let citedPart = originalPart;
    const sortedEntries = [...partCitations.entries()].sort((a, b) => b[0] - a[0]);
    for (const [byteEndIndex, sourceNumbers] of sortedEntries) {
      const stringEndIndex = utf8ByteOffsetToStringIndex(originalPart, byteEndIndex);
      const citationText = [...sourceNumbers].sort((a, b) => a - b).map((n) => `[${n}]`).join("");
      if (!citationText) continue;
      citedPart = `${citedPart.slice(0, stringEndIndex)}${citationText}${citedPart.slice(stringEndIndex)}`;
      hasInlineCitations = true;
    }

    updatedParts[partIndex] = citedPart;
  }

  return {
    text: joinTextParts(updatedParts),
    hasInlineCitations,
  };
}

function base64Url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwtRS256(unsignedJwt: string, privateKeyPem: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedJwt);
  signer.end();
  return signer.sign(privateKeyPem).toString("base64url");
}

async function loadServiceAccountCredentials(credentialsPath: string): Promise<ServiceAccountCredentials> {
  const parsed = JSON.parse(await fs.readFile(credentialsPath, "utf8")) as ServiceAccountCredentials;

  if (parsed.type !== "service_account") {
    throw new Error(`Invalid GOOGLE_APPLICATION_CREDENTIALS type: expected service_account, got ${parsed.type || "unknown"}`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Invalid service account JSON: missing client_email or private_key");
  }

  return parsed;
}

async function getAccessTokenFromServiceAccount(credentialsPath: string, signal?: AbortSignal): Promise<string> {
  const nowMs = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - nowMs > 60_000) return cachedToken.token;

  cachedCredentials ??= await loadServiceAccountCredentials(credentialsPath);
  const tokenUri = cachedCredentials.token_uri || DEFAULT_TOKEN_URI;
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;

  const unsignedJwt = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({
      iss: cachedCredentials.client_email,
      scope: GOOGLE_OAUTH_SCOPE,
      aud: tokenUri,
      iat,
      exp,
    }),
  )}`;

  const assertion = `${unsignedJwt}.${signJwtRS256(unsignedJwt, cachedCredentials.private_key)}`;

  const tokenResp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal,
  });

  if (!tokenResp.ok) {
    throw new Error(`OAuth token request failed (${tokenResp.status}): ${await tokenResp.text()}`);
  }

  const tokenJson = (await tokenResp.json()) as { access_token?: string; expires_in?: number };
  if (!tokenJson.access_token) throw new Error("OAuth token response missing access_token");

  cachedToken = {
    token: tokenJson.access_token,
    expiresAtMs: nowMs + (tokenJson.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

export default function (pi: ExtensionAPI) {
  const { config, missing } = getConfigFromEnv();
  if (!config) {
    console.warn(
      `[websearch] disabled: missing required env ${missing.join(", ")}. Set ${REQUIRED_ENV.join(", ")} to enable.`,
    );
    return;
  }

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description:
      "Search the public web using Vertex AI Gemini with Google Search grounding. Returns a concise answer plus source URLs from grounding metadata, resolving Google grounding redirects when possible.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query to run" }),
      model: Type.Optional(
        Type.String({
          description: `Vertex Gemini model id (default: ${DEFAULT_MODEL}; experimental override example: gemini-3-flash-preview)`,
        }),
      ),
      maxSources: Type.Optional(
        Type.Number({ minimum: 1, maximum: 20, description: "Maximum number of source URLs to return" }),
      ),
      showSources: Type.Optional(
        Type.Boolean({ description: "Include source URLs in visible output (default: false)" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const query = params.query.trim();
        if (!query) {
          return {
            isError: true,
            content: [{ type: "text", text: "query must be non-empty" }],
            details: { error: "query must be non-empty" },
          };
        }

        const model = params.model?.trim() || DEFAULT_MODEL;
        if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid model identifier: "${model}"` }],
            details: { error: "model parameter contains disallowed characters" },
          };
        }

        const maxSources = Math.min(Math.max(params.maxSources ?? DEFAULT_MAX_SOURCES, 1), 20);
        const showSources = params.showSources === true;
        const token = await getAccessTokenFromServiceAccount(config.credentialsPath, signal);
        const endpoint = buildVertexEndpoint(config.project, config.location, model);

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: query }] }],
            tools: [{ googleSearch: {} }],
            generationConfig: { temperature: 0.2 },
          }),
          signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          return {
            isError: true,
            content: [{ type: "text", text: `Vertex request failed (${response.status}): ${errText}` }],
            details: { error: errText, status: response.status },
          };
        }

        const json = (await response.json()) as VertexResponse;
        const textParts = extractTextParts(json);
        const groundingMetadata = json.candidates?.[0]?.groundingMetadata;
        const chunkSourceRecords = extractChunkSourceRecords(json);
        const citedChunkIndices = extractCitedChunkIndices(groundingMetadata?.groundingSupports);
        const { selectedRecords } = selectChunkSourceRecords(chunkSourceRecords, citedChunkIndices, maxSources);
        const resolvedChunkSourceRecords = await resolveChunkSourceRecords(selectedRecords, signal);
        const { sources, chunkIndexToSourceNumber } = buildVisibleSources(resolvedChunkSourceRecords);
        const { text: answer, hasInlineCitations } = addInlineCitations(
          textParts,
          groundingMetadata?.groundingSupports,
          chunkIndexToSourceNumber,
        );

        const sourceLines = hasInlineCitations
          ? sources.map((s, i) => `${i + 1}. ${s.url}`).join("\n")
          : sources.map((s) => s.url).join("\n");

        const sourceSummary = sources.length > 0
          ? `Showing ${sources.length} ${hasInlineCitations ? "cited" : "grounded"} source${sources.length === 1 ? "" : "s"}.`
          : "No grounded sources returned.";

        const visibleOutput = [
          answer ? `Summary:\n${answer}` : "Summary: (model returned no text)",
          "",
          sourceSummary,
          "",
          showSources
            ? (sources.length > 0 ? `Sources:\n${sourceLines}` : "Sources: none returned by grounding metadata")
            : hasInlineCitations
              ? "Cited source URLs are available in tool details."
              : "Source URLs are available in tool details.",
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: visibleOutput,
            },
          ],
          details: {
            model,
            project: config.project,
            location: config.location,
            query,
            sourceCount: sources.length,
            displayedSourceCount: sources.length,
            groundingChunkCount: chunkSourceRecords.length,
            hasInlineCitations,
            sources,
            groundingMetadata,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `websearch failed: ${message}` }],
          details: { error: message },
        };
      }
    },
  });
}
