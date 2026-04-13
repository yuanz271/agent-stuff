import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  MAX_HANDOFF_CHARS,
  getContextCwd,
  getMessagesSinceLastUser,
  truncate,
} from "./runtime.js";

function handoffArtifactsDir(runtimeDir: string): string {
  return join(runtimeDir, "handoffs");
}

function handoffArtifactPath(runtimeDir: string, handoffId: string): string {
  return join(handoffArtifactsDir(runtimeDir), `${handoffId}.md`);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function writeHandoffArtifact(runtimeDir: string, handoffId: string, spec: string): Promise<{
  artifactPath: string;
  artifactSha256: string;
  artifactBytes: number;
}> {
  const dir = handoffArtifactsDir(runtimeDir);
  const artifactPath = handoffArtifactPath(runtimeDir, handoffId);
  const content = spec.trimEnd() + "\n";
  const artifactSha256 = sha256Hex(content);
  const tempPath = join(dir, `.${handoffId}.${randomUUID()}.tmp`);

  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, artifactPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to write handoff artifact ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    artifactPath,
    artifactSha256,
    artifactBytes: Buffer.byteLength(content, "utf8"),
  };
}

export async function validateHandoffArtifact(
  runtimeDir: string,
  handoffId: string,
  payload: Record<string, unknown>,
): Promise<{ artifactPath: string; artifactSha256: string }> {
  const artifactPath = typeof payload.artifactPath === "string" && payload.artifactPath.trim()
    ? payload.artifactPath.trim()
    : "";
  if (!artifactPath) throw new Error("handoff artifactPath is required.");

  const expectedPath = resolvePath(handoffArtifactPath(runtimeDir, handoffId));
  const resolvedArtifactPath = resolvePath(artifactPath);
  if (resolvedArtifactPath !== expectedPath) {
    throw new Error(`handoff artifact path mismatch: expected ${expectedPath}`);
  }

  let artifactText: string;
  try {
    artifactText = await fs.readFile(resolvedArtifactPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read handoff artifact ${resolvedArtifactPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!artifactText.trim()) throw new Error(`Handoff artifact ${resolvedArtifactPath} is empty.`);

  const artifactSha256 = sha256Hex(artifactText);
  const expectedSha256 = typeof payload.artifactSha256 === "string" && payload.artifactSha256.trim()
    ? payload.artifactSha256.trim()
    : "";
  if (expectedSha256 && artifactSha256 !== expectedSha256) {
    throw new Error(`handoff artifact checksum mismatch for ${resolvedArtifactPath}`);
  }

  return { artifactPath: resolvedArtifactPath, artifactSha256 };
}

export function buildHandoffPointerText(params: {
  handoffId: string;
  artifactPath: string;
  artifactSha256: string;
  summary?: string;
}): string {
  const summary = typeof params.summary === "string" && params.summary.trim()
    ? truncate(params.summary.trim(), 500)
    : undefined;
  return [
    "[LEAD-WORKER HANDOFF]",
    `handoff_id: ${params.handoffId}`,
    `artifact_path: ${params.artifactPath}`,
    `artifact_sha256: ${params.artifactSha256}`,
    ...(summary ? ["", "Summary:", summary] : []),
    "",
    "Read the handoff artifact above and treat it as the authoritative spec for this handoff.",
    "Implement it in the worker session, then report progress and exactly one terminal update as usual.",
  ].join("\n");
}

export function buildHandoffText(ctx: ExtensionContext, extraInstructions: string, handoffId: string): string | null {
  const recent = getMessagesSinceLastUser(ctx);
  const trimmedExtra = extraInstructions.trim();
  if (recent.length === 0 && !trimmedExtra) return null;

  const lines = [
    `Lead handoff from session ${ctx.sessionManager.getSessionId()} in ${getContextCwd(ctx)}.`,
    "Implement the agreed plan in the repo-scoped worker. The lead should avoid direct repo edits.",
    `handoff_id: ${handoffId}`,
    'Direct paired communication is available through lead_worker({ action: "message", name: "progress", message: "..." }), structured execution-update events via lead_worker({ action: "message", name: "completed" | "failed" | "cancelled" | "blocker" | "clarification_needed", message: "short summary", payload: {...} }), live clarification via lead_worker({ action: "ask", name: "clarification", message: "..." }), and lead_worker({ action: "reply", replyTo: "...", message: "..." }).',
    "",
  ];

  if (trimmedExtra) lines.push("Additional build instruction:", trimmedExtra, "");
  if (recent.length > 0) {
    lines.push("Recent lead exchange:", "");
    for (const message of recent) {
      const role = message.role === "user" ? "User" : "Lead";
      lines.push(`${role}:`, message.content, "");
    }
  }

  lines.push(
    "Execution expectations:",
    "- send intent/spec only: goal, relevant files, implementation steps, constraints, and validation criteria",
    "- do not send concrete code snippets, patches, or copy-paste-ready implementation blocks to the worker",
    "- implement the requested change in the worker session",
    "- run the smallest relevant validation",
    '- send exactly one terminal update to the lead for this handoff via lead_worker({ action: "message", name: "completed" | "failed" | "cancelled", message: "short summary", payload: {...} })',
    '- terminal payloads must match lead-worker/execution-update@1 and include handoffId, summary, filesChanged, validation, and nextStep when relevant',
    '- blocker and clarification_needed updates should also use structured execution-update payloads',
    '- send progress/blocker/clarification updates only when materially useful',
    '- use lead_worker({ action: "ask", ... }) only when you need a live answer from an attached lead before continuing',
    '- if the clarification should remain visible across disconnects or resume, send lead_worker({ action: "message", name: "clarification_needed", message: "short summary", payload: {...} })',
    "- if blocked on the task itself, report the minimal blocker and the next action needed",
  );

  const joined = lines.join("\n").trim();
  return joined.length <= MAX_HANDOFF_CHARS ? joined : joined.slice(0, MAX_HANDOFF_CHARS - 1) + "…";
}
