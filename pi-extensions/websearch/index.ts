import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createSign } from "node:crypto";
import { promises as fs } from "node:fs";

type GroundingMetadata = {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
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

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_SOURCES = 8;
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REQUIRED_ENV = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
] as const;

let cachedToken: { token: string; expiresAtMs: number } | null = null;
let cachedCredentials: ServiceAccountCredentials | null = null;

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
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

function extractText(resp: VertexResponse): string {
  return resp.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("\n").trim() || "";
}

function extractSources(resp: VertexResponse): Array<{ title: string; url: string; domain: string; isGroundingRedirect: boolean }> {
  const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string; domain: string; isGroundingRedirect: boolean }> = [];

  for (const chunk of chunks) {
    const url = chunk.web?.uri?.replace(/\s+/g, "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    let domain = "unknown";
    let isGroundingRedirect = false;
    try {
      const parsed = new URL(url);
      domain = parsed.hostname || "unknown";
      isGroundingRedirect = parsed.hostname === "vertexaisearch.cloud.google.com" && parsed.pathname.includes("grounding-api-redirect");
    } catch {
      // keep defaults
    }

    out.push({
      title: chunk.web?.title?.trim() || url,
      url,
      domain,
      isGroundingRedirect,
    });
  }

  return out;
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
      "Search the public web using Vertex AI Gemini with Google Search grounding. Returns a concise answer plus source URLs from grounding metadata.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query to run" }),
      model: Type.Optional(Type.String({ description: `Vertex Gemini model id (default: ${DEFAULT_MODEL})` })),
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
        const answer = extractText(json);
        const sources = extractSources(json).slice(0, maxSources);

        const sourceLines = sources
          .map((s, i) => {
            const redirectTag = s.isGroundingRedirect ? " [grounding redirect]" : "";
            return `${i + 1}. ${s.title} (${s.domain})${redirectTag}\n   ${s.url}`;
          })
          .join("\n");

        const visibleOutput = [
          answer ? `Summary:\n${answer}` : "Summary: (model returned no text)",
          "",
          `Verified from ${sources.length} grounded source${sources.length === 1 ? "" : "s"}.`,
          "",
          showSources
            ? (sources.length > 0 ? `Sources:\n${sourceLines}` : "Sources: none returned by grounding metadata")
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
            sources,
            groundingMetadata: json.candidates?.[0]?.groundingMetadata,
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
