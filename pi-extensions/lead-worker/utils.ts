import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { LeadWorkerSettings } from "./settings.js";

const STATE_VERSION = 2;
const CAPTURE_LINES = 40;
const LOG_TAIL_BYTES = 32 * 1024;
const TMUX_FORMAT = "#{session_id}\t#{window_id}\t#{pane_id}";
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const WORKER_BASE_NAME = "worker";
const DEFAULT_WORKER_SLOT = "default";
const PAIR_ID_PATH_CHARS = 16;
const SOCKET_RUNTIME_BASE_DIR = join(homedir(), ".pi", "lead-worker-sockets");

export type LeadWorkerAction = "start" | "status" | "stop";

export type LeadSessionBinding = {
  sessionId: string;
  sessionFile?: string;
};

export type WorkerState = {
  version: number;
  pairId: string;
  projectRoot: string;
  leadSessionId?: string;
  leadSessionFile?: string;
  tmuxSession: string;
  tmuxSessionId?: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
  sessionFile: string;
  logFile: string;
  launchScript: string;
  systemPromptFile: string;
  startupPromptFile: string;
  protocolDir: string;
  socketPath: string;
  agentName: string;
  model: string;
  thinking: ThinkingLevel;
  startedAt?: string;
  lastStoppedAt?: string;
};

export type WorkerStatus = {
  ok: true;
  action: LeadWorkerAction;
  running: boolean;
  alreadyRunning?: boolean;
  message: string;
  pairId: string;
  projectRoot: string;
  leadSessionId?: string;
  leadSessionFile?: string;
  tmuxSession: string;
  tmuxSessionId?: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
  sessionFile: string;
  logFile: string;
  launchScript: string;
  systemPromptFile: string;
  startupPromptFile: string;
  protocolDir: string;
  socketPath: string;
  agentName: string;
  model: string;
  thinking: ThinkingLevel;
  startedAt?: string;
  lastStoppedAt?: string;
  warnings: string[];
  backlog: string[];
};

export type PairRuntimePaths = {
  pairId: string;
  projectRoot: string;
  runtimeDir: string;
  protocolDir: string;
  socketPath: string;
};

type Paths = {
  pairId: string;
  projectRoot: string;
  runtimeDir: string;
  protocolDir: string;
  stateFile: string;
  logFile: string;
  launchScript: string;
  systemPromptFile: string;
  startupPromptFile: string;
  sessionFile: string;
  socketPath: string;
  tmuxSession: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

function stripTerminalNoise(text: string): string {
  return text.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "").replace(/\r/g, "").replace(CONTROL_RE, "");
}

function cleanLines(text: string): string[] {
  return stripTerminalNoise(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-CAPTURE_LINES);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function computePairId(projectRoot: string, workerSlot = DEFAULT_WORKER_SLOT): string {
  return createHash("sha256").update(`${projectRoot}:${workerSlot}`).digest("hex");
}

export function pairIdTag(pairId: string): string {
  return pairId.slice(0, PAIR_ID_PATH_CHARS);
}

function getWorkerAgentName(_settings: LeadWorkerSettings, pairId: string): string {
  return `${WORKER_BASE_NAME}-${pairId.slice(0, 10)}`;
}

function getWorkerModel(settings: LeadWorkerSettings): string {
  return settings.worker.model;
}

function getWorkerThinking(settings: LeadWorkerSettings): ThinkingLevel {
  return settings.worker.thinking;
}

function tmuxSessionName(projectRoot: string, pairId: string): string {
  const projectBase = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18) || "project";
  return `lead-worker-${projectBase}-${pairId.slice(0, 10)}`;
}

function buildProtocolPaths(pairId: string): { protocolDir: string; socketPath: string } {
  const protocolDir = join(SOCKET_RUNTIME_BASE_DIR, pairIdTag(pairId), "protocol-v2");
  return {
    protocolDir,
    socketPath: join(protocolDir, "worker.sock"),
  };
}

function buildPaths(projectRoot: string, settings: LeadWorkerSettings): Paths {
  const pairId = computePairId(projectRoot);
  const workerAgentName = getWorkerAgentName(settings, pairId);
  const runtimeDir = join(projectRoot, ".pi", "lead-worker", pairIdTag(pairId));
  const { protocolDir, socketPath } = buildProtocolPaths(pairId);

  return {
    pairId,
    projectRoot,
    runtimeDir,
    protocolDir,
    stateFile: join(runtimeDir, "worker-state.json"),
    logFile: join(runtimeDir, "worker.log"),
    launchScript: join(runtimeDir, "launch-worker.sh"),
    systemPromptFile: join(runtimeDir, "worker-system-prompt.md"),
    startupPromptFile: join(runtimeDir, "worker-startup.md"),
    sessionFile: join(projectRoot, ".pi", "sessions", `${workerAgentName}.jsonl`),
    socketPath,
    tmuxSession: tmuxSessionName(projectRoot, pairId),
  };
}

function baseState(paths: Paths, settings: LeadWorkerSettings, leadSession: LeadSessionBinding): WorkerState {
  return {
    version: STATE_VERSION,
    pairId: paths.pairId,
    projectRoot: paths.projectRoot,
    ...(leadSession.sessionId ? { leadSessionId: leadSession.sessionId } : {}),
    ...(leadSession.sessionFile ? { leadSessionFile: leadSession.sessionFile } : {}),
    tmuxSession: paths.tmuxSession,
    sessionFile: paths.sessionFile,
    logFile: paths.logFile,
    launchScript: paths.launchScript,
    systemPromptFile: paths.systemPromptFile,
    startupPromptFile: paths.startupPromptFile,
    protocolDir: paths.protocolDir,
    socketPath: paths.socketPath,
    agentName: getWorkerAgentName(settings, paths.pairId),
    model: getWorkerModel(settings),
    thinking: getWorkerThinking(settings),
  };
}

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd?: string): Promise<ExecResult> {
  const result = await pi.exec(command, args, { cwd, timeout: 10_000 });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.code ?? 1,
  };
}

export async function resolveProjectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const git = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
  const candidate = git.code === 0 && git.stdout.trim() ? git.stdout.trim() : cwd;
  try {
    return await fs.realpath(candidate);
  } catch {
    return resolve(candidate);
  }
}

export async function resolvePairRuntimePaths(pi: ExtensionAPI, cwd: string): Promise<PairRuntimePaths> {
  const projectRoot = await resolveProjectRoot(pi, cwd);
  const pairId = computePairId(projectRoot);
  const runtimeDir = join(projectRoot, ".pi", "lead-worker", pairIdTag(pairId));
  const { protocolDir, socketPath } = buildProtocolPaths(pairId);
  return {
    pairId,
    projectRoot,
    runtimeDir,
    protocolDir,
    socketPath,
  };
}

async function ensureTmuxAvailable(pi: ExtensionAPI, cwd: string): Promise<void> {
  const result = await exec(pi, "tmux", ["-V"], cwd);
  if (result.code !== 0) {
    throw new Error("tmux is required for lead-worker but was not found or is not working");
  }
}

async function tmuxSessionExists(pi: ExtensionAPI, session: string, cwd: string): Promise<boolean> {
  const result = await exec(pi, "tmux", ["has-session", "-t", session], cwd);
  return result.code === 0;
}

async function loadState(stateFile: string): Promise<WorkerState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read worker state ${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw) as WorkerState;
  } catch (error) {
    throw new Error(`Corrupt worker state ${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveState(stateFile: string, state: WorkerState): Promise<void> {
  await fs.mkdir(dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function readTailFromFile(path: string): Promise<string[]> {
  try {
    const handle = await fs.open(path, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, LOG_TAIL_BYTES);
      if (length <= 0) return [];

      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      return cleanLines(buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function captureBacklog(pi: ExtensionAPI, cwd: string, state: WorkerState): Promise<string[]> {
  const target = state.tmuxPaneId?.trim() || `${state.tmuxSession}:0.0`;
  const captured = await exec(pi, "tmux", ["capture-pane", "-p", "-J", "-t", target, "-S", `-${CAPTURE_LINES}`], cwd);
  if (captured.code === 0 && captured.stdout.trim()) {
    return cleanLines(captured.stdout);
  }
  return readTailFromFile(state.logFile);
}

function getPiInvocation(): { command: string; argsPrefix: string[] } {
  const currentEntry = process.argv[1];
  const execName = basename(process.execPath).toLowerCase();
  const looksLikeGenericRuntime = /^(?:node|bun)(?:\.exe)?$/.test(execName);

  if (currentEntry && looksLikeGenericRuntime) {
    return {
      command: process.execPath,
      argsPrefix: [resolve(currentEntry)],
    };
  }

  if (!looksLikeGenericRuntime) {
    return {
      command: process.execPath,
      argsPrefix: [],
    };
  }

  return {
    command: "pi",
    argsPrefix: [],
  };
}

function buildSystemPrompt(settings: LeadWorkerSettings, pairId: string): string {
  const workerAgentName = getWorkerAgentName(settings, pairId);
  const lines = [
    `You are ${workerAgentName}, the persistent worker session for this project.`,
    `Your stable pair id is ${pairId}.`,
    "",
    "Role:",
    "- You are the write-enabled worker counterpart for this repository.",
    '- Use lead_worker({ action: "message", message: "..." }) for concise one-way updates to the active lead.',
    '- Use lead_worker({ action: "reply", replyTo: "...", message: "..." }) when answering a direct worker-side request.',
    "- Do not send acknowledgements or chatter.",
    "- For each delegated handoff, you MUST send exactly one terminal update to the lead when you finish or stop.",
    "- Terminal update must include: handoff_id, status (completed/failed/cancelled), files changed, validation run + result, and any blocker/next action.",
    "- You may send interim updates only for material blockers, clarifications, or useful progress.",
    "- Treat lead messages as intent/specification, not code to paste blindly.",
    "- If lead includes code-like text, extract intent/constraints and implement natively in the repository.",
    "- Execute concrete changes, tests, and diagnostics. Do not start autonomous worker swarms unless explicitly asked.",
    "- When blocked, report the minimal blocking fact and the next concrete action needed.",
  ];

  if (settings.worker.system_prompt_append) {
    lines.push("", settings.worker.system_prompt_append);
  }

  return lines.join("\n");
}

function buildStartupPrompt(settings: LeadWorkerSettings, pairId: string): string {
  const workerAgentName = getWorkerAgentName(settings, pairId);
  const lines = [
    `You are booting as ${workerAgentName}, the persistent worker session for this project.`,
    `This worker serves pair id ${pairId}.`,
    "",
    "Startup checklist:",
    `1. Reply with a short readiness note that explicitly says you are ready for pair ${pairId}.`,
    '2. If you need to contact the lead later, use lead_worker({ action: "message", message: "..." }).',
    '3. If you receive a direct request that expects an answer, respond with lead_worker({ action: "reply", replyTo: "...", message: "..." }).',
    '4. For every delegated handoff, send exactly one terminal update back to the lead with: handoff_id, status, files changed, validation result, and blockers/next action (if any).',
    "5. Then wait for further instructions.",
    "",
    "Do not modify files during this startup handshake.",
  ];

  if (settings.worker.startup_prompt_append) {
    lines.push("", settings.worker.startup_prompt_append);
  }

  return lines.join("\n");
}

async function writeRuntimeFiles(paths: Paths, settings: LeadWorkerSettings, leadSession: LeadSessionBinding): Promise<void> {
  const invocation = getPiInvocation();
  const workerAgentName = getWorkerAgentName(settings, paths.pairId);
  const systemPrompt = buildSystemPrompt(settings, paths.pairId);
  const startupPrompt = buildStartupPrompt(settings, paths.pairId);
  const startupBannerLines = [
    `[lead-worker] ${workerAgentName} pair ${paths.pairId}`,
    ...(leadSession.sessionId ? [`[lead-worker] started by lead session ${leadSession.sessionId}`] : []),
    ...(leadSession.sessionFile ? [`[lead-worker] lead session file ${leadSession.sessionFile}`] : []),
  ];
  const fullArgs = [
    ...invocation.argsPrefix,
    "--session",
    paths.sessionFile,
    "--model",
    getWorkerModel(settings),
    "--thinking",
    getWorkerThinking(settings),
    "--append-system-prompt",
    paths.systemPromptFile,
    startupPrompt,
  ];
  const launchScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${shellQuote(paths.projectRoot)}`,
    ...startupBannerLines.map((line) => `printf '%s\\n' ${shellQuote(line)}`),
    `exec env PI_AGENT_NAME=${shellQuote(workerAgentName)} PI_LEAD_WORKER_ROLE=${shellQuote("worker")} PI_LEAD_WORKER_PAIR_ID=${shellQuote(paths.pairId)} ${shellQuote(invocation.command)} ${fullArgs
      .map(shellQuote)
      .join(" ")}`,
    "",
  ].join("\n");

  await fs.mkdir(join(paths.projectRoot, ".pi", "sessions"), { recursive: true });
  await fs.mkdir(paths.protocolDir, { recursive: true });
  await fs.mkdir(paths.runtimeDir, { recursive: true });
  await fs.writeFile(paths.systemPromptFile, systemPrompt, "utf8");
  await fs.writeFile(paths.startupPromptFile, startupPrompt, "utf8");
  await fs.writeFile(paths.launchScript, launchScript, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(paths.launchScript, 0o755);
}

function parseNewSessionMetadata(stdout: string): { sessionId?: string; windowId?: string; paneId?: string } {
  const [sessionId, windowId, paneId] = stdout.trim().split("\t");
  return {
    sessionId: sessionId?.trim() || undefined,
    windowId: windowId?.trim() || undefined,
    paneId: paneId?.trim() || undefined,
  };
}

function withStateOverrides(
  paths: Paths,
  settings: LeadWorkerSettings,
  leadSession: LeadSessionBinding,
  state: WorkerState | null,
  patch: Partial<WorkerState>,
): WorkerState {
  return {
    ...baseState(paths, settings, leadSession),
    ...(state
      ? {
          startedAt: state.startedAt,
          lastStoppedAt: state.lastStoppedAt,
          tmuxSessionId: state.tmuxSessionId,
          tmuxWindowId: state.tmuxWindowId,
          tmuxPaneId: state.tmuxPaneId,
        }
      : {}),
    ...patch,
  };
}

async function resolveState(
  pi: ExtensionAPI,
  cwd: string,
  settings: LeadWorkerSettings,
  leadSession: LeadSessionBinding,
): Promise<{ paths: Paths; desiredState: WorkerState; existingState: WorkerState | null; warnings: string[] }> {
  const projectRoot = await resolveProjectRoot(pi, cwd);
  const paths = buildPaths(projectRoot, settings);
  const existingState = await loadState(paths.stateFile);
  const desiredState = withStateOverrides(paths, settings, leadSession, existingState, {});
  const warnings: string[] = [];
  return { paths, desiredState, existingState, warnings };
}

function describeAction(action: LeadWorkerAction, agentName: string, running: boolean, alreadyRunning?: boolean): string {
  if (action === "start") {
    return alreadyRunning ? `Worker ${agentName} is already running.` : `Started worker ${agentName} in a detached tmux session.`;
  }
  if (action === "stop") {
    return running ? `Worker ${agentName} is still running.` : `Stopped worker ${agentName}.`;
  }
  return running ? `Worker ${agentName} is running.` : `Worker ${agentName} is not running.`;
}

async function buildStatus(
  pi: ExtensionAPI,
  cwd: string,
  action: LeadWorkerAction,
  state: WorkerState,
  warnings: string[],
  alreadyRunning?: boolean,
): Promise<WorkerStatus> {
  const running = await tmuxSessionExists(pi, state.tmuxSession, cwd);
  const backlog = running ? await captureBacklog(pi, cwd, state) : await readTailFromFile(state.logFile);

  return {
    ok: true,
    action,
    running,
    alreadyRunning,
    message: describeAction(action, state.agentName, running, alreadyRunning),
    pairId: state.pairId,
    projectRoot: state.projectRoot,
    leadSessionId: state.leadSessionId,
    leadSessionFile: state.leadSessionFile,
    tmuxSession: state.tmuxSession,
    tmuxSessionId: state.tmuxSessionId,
    tmuxWindowId: state.tmuxWindowId,
    tmuxPaneId: state.tmuxPaneId,
    sessionFile: state.sessionFile,
    logFile: state.logFile,
    launchScript: state.launchScript,
    systemPromptFile: state.systemPromptFile,
    startupPromptFile: state.startupPromptFile,
    protocolDir: state.protocolDir,
    socketPath: state.socketPath,
    agentName: state.agentName,
    model: state.model,
    thinking: state.thinking,
    startedAt: state.startedAt,
    lastStoppedAt: state.lastStoppedAt,
    warnings,
    backlog,
  };
}

export async function startWorker(
  pi: ExtensionAPI,
  cwd: string,
  settings: LeadWorkerSettings,
  leadSession: LeadSessionBinding,
): Promise<WorkerStatus> {
  await ensureTmuxAvailable(pi, cwd);
  const { paths, desiredState, existingState, warnings } = await resolveState(pi, cwd, settings, leadSession);

  if (await tmuxSessionExists(pi, desiredState.tmuxSession, cwd)) {
    const liveState = existingState ?? desiredState;
    const nextWarnings = existingState
      ? warnings
      : [...warnings, "Worker tmux session is already running, but worker-state.json is missing; reported model/thinking may reflect current settings rather than the live worker process."];
    return buildStatus(pi, cwd, "start", liveState, nextWarnings, true);
  }

  await writeRuntimeFiles(paths, settings, leadSession);

  const started = await exec(
    pi,
    "tmux",
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      TMUX_FORMAT,
      "-s",
      desiredState.tmuxSession,
      "-c",
      paths.projectRoot,
      `bash ${shellQuote(paths.launchScript)}`,
    ],
    cwd,
  );

  if (started.code !== 0) {
    throw new Error(started.stderr.trim() || started.stdout.trim() || `Failed to start tmux session ${desiredState.tmuxSession}`);
  }

  const metadata = parseNewSessionMetadata(started.stdout);
  const nextState = withStateOverrides(paths, settings, leadSession, desiredState, {
    tmuxSessionId: metadata.sessionId,
    tmuxWindowId: metadata.windowId,
    tmuxPaneId: metadata.paneId,
    startedAt: new Date().toISOString(),
    lastStoppedAt: undefined,
  });

  const pipeWarnings: string[] = [];
  if (nextState.tmuxPaneId) {
    const pipeResult = await exec(pi, "tmux", ["pipe-pane", "-t", nextState.tmuxPaneId, "-o", `cat >> ${shellQuote(paths.logFile)}`], cwd);
    if (pipeResult.code !== 0) {
      pipeWarnings.push(`tmux pipe-pane failed (exit ${pipeResult.code}): worker log capture may be missing.`);
    }
  }

  await saveState(paths.stateFile, nextState);
  return buildStatus(
    pi,
    cwd,
    "start",
    nextState,
    [
      ...warnings,
      ...pipeWarnings,
      "Startup is asynchronous. Once the worker socket is ready, use /worker build, lead_worker({ action: \"message\", ... }), lead_worker({ action: \"ask\", ... }), or lead_worker({ action: \"command\", ... }) from the paired lead session.",
    ],
  );
}

export async function getWorkerStatus(
  pi: ExtensionAPI,
  cwd: string,
  settings: LeadWorkerSettings,
  leadSession: LeadSessionBinding,
): Promise<WorkerStatus> {
  const { desiredState, existingState, warnings } = await resolveState(pi, cwd, settings, leadSession);
  const running = await tmuxSessionExists(pi, desiredState.tmuxSession, cwd);
  const liveState = running && existingState ? existingState : desiredState;
  const nextWarnings = running && !existingState
    ? [...warnings, "Worker tmux session is running, but worker-state.json is missing; reported model/thinking may reflect current settings rather than the live worker process."]
    : warnings;
  return buildStatus(pi, cwd, "status", liveState, nextWarnings);
}

export async function stopWorker(
  pi: ExtensionAPI,
  cwd: string,
  settings: LeadWorkerSettings,
  leadSession: LeadSessionBinding,
): Promise<WorkerStatus> {
  await ensureTmuxAvailable(pi, cwd);
  const { paths, desiredState, existingState, warnings } = await resolveState(pi, cwd, settings, leadSession);
  const state = existingState ?? desiredState;

  if (await tmuxSessionExists(pi, state.tmuxSession, cwd)) {
    const stopped = await exec(pi, "tmux", ["kill-session", "-t", state.tmuxSession], cwd);
    if (stopped.code !== 0) {
      throw new Error(stopped.stderr.trim() || stopped.stdout.trim() || `Failed to stop tmux session ${state.tmuxSession}`);
    }
  }

  const nextState = withStateOverrides(paths, settings, leadSession, state, {
    lastStoppedAt: new Date().toISOString(),
  });
  try {
    await fs.unlink(paths.socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw new Error(`Failed to remove worker socket ${paths.socketPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await saveState(paths.stateFile, nextState);
  return buildStatus(pi, cwd, "stop", nextState, warnings);
}
