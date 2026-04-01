import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PlanBuildSettings } from "./settings.js";

const STATE_VERSION = 1;
const CAPTURE_LINES = 40;
const LOG_TAIL_BYTES = 32 * 1024;
const TMUX_FORMAT = "#{session_id}\t#{window_id}\t#{pane_id}";
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export type PlanBuildAction = "start" | "status" | "stop";

export type PlannerSessionBinding = {
  sessionId: string;
  sessionFile?: string;
};

export type BuilderState = {
  version: number;
  projectRoot: string;
  plannerSessionId: string;
  plannerSessionFile?: string;
  tmuxSession: string;
  tmuxSessionId?: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
  sessionFile: string;
  logFile: string;
  launchScript: string;
  systemPromptFile: string;
  startupPromptFile: string;
  agentName: string;
  model: string;
  thinking: ThinkingLevel;
  startedAt?: string;
  lastStoppedAt?: string;
};

export type BuilderStatus = {
  ok: true;
  action: PlanBuildAction;
  running: boolean;
  alreadyRunning?: boolean;
  message: string;
  projectRoot: string;
  plannerSessionId: string;
  plannerSessionFile?: string;
  tmuxSession: string;
  tmuxSessionId?: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
  sessionFile: string;
  logFile: string;
  launchScript: string;
  systemPromptFile: string;
  startupPromptFile: string;
  agentName: string;
  model: string;
  thinking: ThinkingLevel;
  startedAt?: string;
  lastStoppedAt?: string;
  warnings: string[];
  backlog: string[];
};

export type PairChannelPaths = {
  projectRoot: string;
  runtimeDir: string;
  plannerInbox: string;
  builderInbox: string;
};

type Paths = {
  projectRoot: string;
  runtimeDir: string;
  stateFile: string;
  logFile: string;
  launchScript: string;
  systemPromptFile: string;
  startupPromptFile: string;
  sessionFile: string;
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

function getConfiguredBuilderAgentName(settings: PlanBuildSettings): string {
  return settings.builder.agent_name;
}

export function plannerSessionTag(plannerSession: PlannerSessionBinding): string {
  return createHash("sha1").update(plannerSession.sessionId).digest("hex").slice(0, 10);
}

function getBuilderAgentName(settings: PlanBuildSettings, plannerSession: PlannerSessionBinding): string {
  return `${getConfiguredBuilderAgentName(settings)}-${plannerSessionTag(plannerSession)}`;
}

function getBuilderModel(settings: PlanBuildSettings): string {
  return settings.builder.model;
}

function getBuilderThinking(settings: PlanBuildSettings): ThinkingLevel {
  return settings.builder.thinking;
}

function tmuxSessionName(projectRoot: string, builderAgentName: string): string {
  const projectBase = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18) || "project";
  const agentBase = builderAgentName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12) || "builder";
  const suffix = createHash("sha1").update(`${projectRoot}:${builderAgentName}`).digest("hex").slice(0, 8);
  return `plan-${agentBase}-${projectBase}-${suffix}`;
}

function buildPaths(projectRoot: string, settings: PlanBuildSettings, plannerSession: PlannerSessionBinding): Paths {
  const sessionTag = plannerSessionTag(plannerSession);
  const runtimeDir = join(projectRoot, ".pi", "plan-build", sessionTag);
  const builderAgentName = getBuilderAgentName(settings, plannerSession);

  return {
    projectRoot,
    runtimeDir,
    stateFile: join(runtimeDir, "builder-state.json"),
    logFile: join(runtimeDir, "builder.log"),
    launchScript: join(runtimeDir, "launch-builder.sh"),
    systemPromptFile: join(runtimeDir, "builder-system-prompt.md"),
    startupPromptFile: join(runtimeDir, "builder-startup.md"),
    sessionFile: join(projectRoot, ".pi", "sessions", `${builderAgentName}.jsonl`),
    tmuxSession: tmuxSessionName(projectRoot, builderAgentName),
  };
}

function baseState(paths: Paths, settings: PlanBuildSettings, plannerSession: PlannerSessionBinding): BuilderState {
  return {
    version: STATE_VERSION,
    projectRoot: paths.projectRoot,
    plannerSessionId: plannerSession.sessionId,
    ...(plannerSession.sessionFile ? { plannerSessionFile: plannerSession.sessionFile } : {}),
    tmuxSession: paths.tmuxSession,
    sessionFile: paths.sessionFile,
    logFile: paths.logFile,
    launchScript: paths.launchScript,
    systemPromptFile: paths.systemPromptFile,
    startupPromptFile: paths.startupPromptFile,
    agentName: getBuilderAgentName(settings, plannerSession),
    model: getBuilderModel(settings),
    thinking: getBuilderThinking(settings),
  };
}

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd?: string): Promise<ExecResult> {
  const result = await pi.exec(command, args, { cwd, timeout: 10_000 });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    // Treat undefined exit code (timeout, internal error) as failure.
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

export async function resolvePairChannelPaths(
  pi: ExtensionAPI,
  cwd: string,
  plannerSession: PlannerSessionBinding,
): Promise<PairChannelPaths> {
  const projectRoot = await resolveProjectRoot(pi, cwd);
  const runtimeDir = join(projectRoot, ".pi", "plan-build", plannerSessionTag(plannerSession));
  return {
    projectRoot,
    runtimeDir,
    plannerInbox: join(runtimeDir, "planner-inbox"),
    builderInbox: join(runtimeDir, "builder-inbox"),
  };
}

async function ensureTmuxAvailable(pi: ExtensionAPI, cwd: string): Promise<void> {
  const result = await exec(pi, "tmux", ["-V"], cwd);
  if (result.code !== 0) {
    throw new Error("tmux is required for plan-build but was not found or is not working");
  }
}

async function tmuxSessionExists(pi: ExtensionAPI, session: string, cwd: string): Promise<boolean> {
  const result = await exec(pi, "tmux", ["has-session", "-t", session], cwd);
  return result.code === 0;
}

async function loadState(stateFile: string): Promise<BuilderState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile, "utf8");
  } catch {
    // File not found or unreadable — no persisted state.
    return null;
  }
  // Let JSON.parse throw on corrupt data so callers see the failure
  // instead of silently losing temporal metadata and tmux pane IDs.
  return JSON.parse(raw) as BuilderState;
}

async function saveState(stateFile: string, state: BuilderState): Promise<void> {
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

async function captureBacklog(pi: ExtensionAPI, cwd: string, state: BuilderState): Promise<string[]> {
  const target = state.tmuxPaneId?.trim() || `${state.tmuxSession}:0.0`;
  const captured = await exec(pi, "tmux", ["capture-pane", "-p", "-J", "-t", target, "-S", `-${CAPTURE_LINES}`], cwd);
  if (captured.code === 0 && captured.stdout.trim()) {
    return cleanLines(captured.stdout);
  }
  return readTailFromFile(state.logFile);
}

/**
 * Infer the command and arguments needed to re-invoke the current Pi process.
 * Heuristic: checks process.execPath against known runtimes (node, bun).
 * May need a settings override (e.g. builder.pi_command) if Pi is invoked
 * through an unusual runtime or wrapper not covered here.
 */
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

function buildSystemPrompt(settings: PlanBuildSettings, plannerSession: PlannerSessionBinding): string {
  const builderAgentName = getBuilderAgentName(settings, plannerSession);
  const lines = [
    `You are ${builderAgentName}, the persistent builder session for this project.`,
    `You are dedicated to planner session ${plannerSession.sessionId}.`,
    "",
    "Role:",
    "- You are the write-enabled builder counterpart to the planner session.",
    "- Preserve continuity across turns; this session is meant to accumulate implementation context over time.",
    "- Use plan_build({ action: \"message\", message: \"...\" }) for concise direct messages to the paired planner when needed.",
    "- Do not send acknowledgements or chatter.",
    "- For each delegated handoff, you MUST send exactly one completion message to the planner when you finish or stop.",
    "- Completion message format: handoff_id, status (done/blocked), files changed, validation run + result, and any blocker/next action.",
    "- You may send additional messages only for material blockers or concrete clarification questions.",
    "- Execute concrete changes, tests, and diagnostics. Do not start autonomous worker swarms unless explicitly asked.",
    "- When blocked, report the minimal blocking fact and the next concrete action needed.",
  ];

  if (settings.builder.system_prompt_append) {
    lines.push("", settings.builder.system_prompt_append);
  }

  return lines.join("\n");
}

function buildStartupPrompt(settings: PlanBuildSettings, plannerSession: PlannerSessionBinding): string {
  const builderAgentName = getBuilderAgentName(settings, plannerSession);
  const lines = [
    `You are booting as ${builderAgentName}, the persistent builder session for this project.`,
    `This builder is reserved for planner session ${plannerSession.sessionId}.`,
    "",
    "Startup checklist:",
    `1. Reply with a short readiness note that explicitly says you are paired with planner session ${plannerSession.sessionId} and ready for direct paired plan-build messages.`,
    '2. If you need to contact the planner later, use plan_build({ action: "message", message: "..." }).',
    '3. For every delegated handoff, send exactly one completion message back to the planner with: handoff_id, status, files changed, validation result, and blockers/next action (if any).',
    "4. Then wait for further instructions.",
    "",
    "Do not modify files during this startup handshake.",
  ];

  if (settings.builder.startup_prompt_append) {
    lines.push("", settings.builder.startup_prompt_append);
  }

  return lines.join("\n");
}

async function writeRuntimeFiles(paths: Paths, settings: PlanBuildSettings, plannerSession: PlannerSessionBinding): Promise<void> {
  const invocation = getPiInvocation();
  const builderAgentName = getBuilderAgentName(settings, plannerSession);
  const systemPrompt = buildSystemPrompt(settings, plannerSession);
  const startupPrompt = buildStartupPrompt(settings, plannerSession);
  const startupBannerLines = [
    `[plan-build] ${builderAgentName} paired with planner session ${plannerSession.sessionId}`,
    ...(plannerSession.sessionFile ? [`[plan-build] planner session file ${plannerSession.sessionFile}`] : []),
  ];
  const fullArgs = [
    ...invocation.argsPrefix,
    "--session",
    paths.sessionFile,
    "--model",
    getBuilderModel(settings),
    "--thinking",
    getBuilderThinking(settings),
    "--append-system-prompt",
    paths.systemPromptFile,
    startupPrompt,
  ];
  const launchScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${shellQuote(paths.projectRoot)}`,
    ...startupBannerLines.map((line) => `printf '%s\\n' ${shellQuote(line)}`),
    `exec env PI_AGENT_NAME=${shellQuote(builderAgentName)} PI_PLAN_MODE_ROLE=${shellQuote("builder")} PI_PLAN_BUILD_PLANNER_SESSION_ID=${shellQuote(plannerSession.sessionId)} ${shellQuote(invocation.command)} ${fullArgs
      .map(shellQuote)
      .join(" ")}`,
    "",
  ].join("\n");

  await fs.mkdir(join(paths.projectRoot, ".pi", "sessions"), { recursive: true });
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
  settings: PlanBuildSettings,
  plannerSession: PlannerSessionBinding,
  state: BuilderState | null,
  patch: Partial<BuilderState>,
): BuilderState {
  // Start from config-derived defaults, then selectively preserve temporal/
  // runtime fields from the existing persisted state, then apply the patch.
  return {
    ...baseState(paths, settings, plannerSession),
    // Preserve only temporal and runtime fields from persisted state:
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
  settings: PlanBuildSettings,
  plannerSession: PlannerSessionBinding,
): Promise<{ paths: Paths; state: BuilderState; warnings: string[] }> {
  const projectRoot = await resolveProjectRoot(pi, cwd);
  const paths = buildPaths(projectRoot, settings, plannerSession);
  const existing = await loadState(paths.stateFile);
  const state = withStateOverrides(paths, settings, plannerSession, existing, {});
  const warnings: string[] = [];
  return { paths, state, warnings };
}

function describeAction(action: PlanBuildAction, agentName: string, running: boolean, alreadyRunning?: boolean): string {
  if (action === "start") {
    return alreadyRunning ? `Builder ${agentName} is already running.` : `Started builder ${agentName} in a detached tmux session.`;
  }
  if (action === "stop") {
    return running ? `Builder ${agentName} is still running.` : `Stopped builder ${agentName}.`;
  }
  return running ? `Builder ${agentName} is running.` : `Builder ${agentName} is not running.`;
}

async function buildStatus(
  pi: ExtensionAPI,
  cwd: string,
  action: PlanBuildAction,
  state: BuilderState,
  warnings: string[],
  alreadyRunning?: boolean,
): Promise<BuilderStatus> {
  const running = await tmuxSessionExists(pi, state.tmuxSession, cwd);
  const backlog = running ? await captureBacklog(pi, cwd, state) : await readTailFromFile(state.logFile);

  return {
    ok: true,
    action,
    running,
    alreadyRunning,
    message: describeAction(action, state.agentName, running, alreadyRunning),
    projectRoot: state.projectRoot,
    plannerSessionId: state.plannerSessionId,
    plannerSessionFile: state.plannerSessionFile,
    tmuxSession: state.tmuxSession,
    tmuxSessionId: state.tmuxSessionId,
    tmuxWindowId: state.tmuxWindowId,
    tmuxPaneId: state.tmuxPaneId,
    sessionFile: state.sessionFile,
    logFile: state.logFile,
    launchScript: state.launchScript,
    systemPromptFile: state.systemPromptFile,
    startupPromptFile: state.startupPromptFile,
    agentName: state.agentName,
    model: state.model,
    thinking: state.thinking,
    startedAt: state.startedAt,
    lastStoppedAt: state.lastStoppedAt,
    warnings,
    backlog,
  };
}

export async function startBuilder(
  pi: ExtensionAPI,
  cwd: string,
  settings: PlanBuildSettings,
  plannerSession: PlannerSessionBinding,
): Promise<BuilderStatus> {
  await ensureTmuxAvailable(pi, cwd);
  const { paths, state, warnings } = await resolveState(pi, cwd, settings, plannerSession);

  if (await tmuxSessionExists(pi, state.tmuxSession, cwd)) {
    await saveState(paths.stateFile, state);
    return buildStatus(pi, cwd, "start", state, warnings, true);
  }

  await writeRuntimeFiles(paths, settings, plannerSession);

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
      state.tmuxSession,
      "-c",
      paths.projectRoot,
      `bash ${shellQuote(paths.launchScript)}`,
    ],
    cwd,
  );

  if (started.code !== 0) {
    throw new Error(started.stderr.trim() || started.stdout.trim() || `Failed to start tmux session ${state.tmuxSession}`);
  }

  const metadata = parseNewSessionMetadata(started.stdout);
  const nextState = withStateOverrides(paths, settings, plannerSession, state, {
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
      pipeWarnings.push(`tmux pipe-pane failed (exit ${pipeResult.code}): builder log capture may be missing.`);
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
      "Startup is asynchronous. Once the builder reports ready, use /build or plan_build({ action: \"message\", message: \"...\" }) from the paired planner session to send work.",
    ],
  );
}

export async function getBuilderStatus(
  pi: ExtensionAPI,
  cwd: string,
  settings: PlanBuildSettings,
  plannerSession: PlannerSessionBinding,
): Promise<BuilderStatus> {
  const { state, warnings } = await resolveState(pi, cwd, settings, plannerSession);
  return buildStatus(pi, cwd, "status", state, warnings);
}

export async function stopBuilder(
  pi: ExtensionAPI,
  cwd: string,
  settings: PlanBuildSettings,
  plannerSession: PlannerSessionBinding,
): Promise<BuilderStatus> {
  await ensureTmuxAvailable(pi, cwd);
  const { paths, state, warnings } = await resolveState(pi, cwd, settings, plannerSession);

  if (await tmuxSessionExists(pi, state.tmuxSession, cwd)) {
    const stopped = await exec(pi, "tmux", ["kill-session", "-t", state.tmuxSession], cwd);
    if (stopped.code !== 0) {
      throw new Error(stopped.stderr.trim() || stopped.stdout.trim() || `Failed to stop tmux session ${state.tmuxSession}`);
    }
  }

  const nextState = withStateOverrides(paths, settings, plannerSession, state, {
    lastStoppedAt: new Date().toISOString(),
  });
  await saveState(paths.stateFile, nextState);
  return buildStatus(pi, cwd, "stop", nextState, warnings);
}
