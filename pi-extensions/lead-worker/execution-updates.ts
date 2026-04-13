const EXECUTION_UPDATE_SCHEMA = "lead-worker/execution-update@1" as const;

export const TERMINAL_UPDATE_STATUSES = ["completed", "failed", "cancelled"] as const;
export const ATTENTION_UPDATE_STATUSES = ["blocker", "clarification_needed"] as const;
export const HIGH_SIGNAL_UPDATE_STATUSES = [...TERMINAL_UPDATE_STATUSES, ...ATTENTION_UPDATE_STATUSES] as const;

export type TerminalUpdateStatus = typeof TERMINAL_UPDATE_STATUSES[number];
export type AttentionUpdateStatus = typeof ATTENTION_UPDATE_STATUSES[number];
export type HighSignalUpdateStatus = typeof HIGH_SIGNAL_UPDATE_STATUSES[number];

export type ValidationRecord = {
  command: string;
  result: "passed" | "failed" | "skipped";
  details?: string;
};

type BaseExecutionUpdate = {
  schema: typeof EXECUTION_UPDATE_SCHEMA;
  handoffId: string;
  summary: string;
  handoffArtifactPath?: string;
  handoffArtifactSha256?: string;
};

export type TerminalExecutionUpdate = BaseExecutionUpdate & {
  kind: "terminal";
  status: TerminalUpdateStatus;
  filesChanged: string[];
  validation: ValidationRecord[];
  nextStep?: string;
};

export type AttentionExecutionUpdate = BaseExecutionUpdate & {
  kind: "attention";
  status: AttentionUpdateStatus;
  nextStep: string;
  blocker?: string;
  question?: string;
  filesChanged?: string[];
  validation?: ValidationRecord[];
};

export type ExecutionUpdatePayload = TerminalExecutionUpdate | AttentionExecutionUpdate;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string when present`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeStringArray(value: unknown, label: string, required: boolean): string[] {
  if (value === undefined) {
    if (required) throw new Error(`${label} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  return value
    .map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`))
    .filter((entry, index, array) => array.indexOf(entry) === index);
}

function parseValidationRecord(value: unknown, index: number): ValidationRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(`validation[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const command = requireNonEmptyString(record.command, `validation[${index}].command`);
  const result = record.result;
  if (result !== "passed" && result !== "failed" && result !== "skipped") {
    throw new Error(`validation[${index}].result must be 'passed', 'failed', or 'skipped'`);
  }
  const details = optionalString(record.details, `validation[${index}].details`);
  return {
    command,
    result,
    ...(details ? { details } : {}),
  };
}

function parseValidationRecords(value: unknown, required: boolean): ValidationRecord[] {
  if (value === undefined) {
    if (required) throw new Error("validation is required");
    return [];
  }
  if (!Array.isArray(value)) throw new Error("validation must be an array");
  return value.map(parseValidationRecord);
}

export function isHighSignalWorkerEvent(name: string): name is HighSignalUpdateStatus {
  return HIGH_SIGNAL_UPDATE_STATUSES.includes(name as HighSignalUpdateStatus);
}

export function parseExecutionUpdatePayload(
  value: unknown,
  expectedStatus?: string,
): ExecutionUpdatePayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("execution update payload must be an object");
  }

  const payload = value as Record<string, unknown>;
  if (payload.schema !== EXECUTION_UPDATE_SCHEMA) {
    throw new Error(`execution update payload.schema must be '${EXECUTION_UPDATE_SCHEMA}'`);
  }

  const kind = payload.kind;
  if (kind !== "terminal" && kind !== "attention") {
    throw new Error("execution update payload.kind must be 'terminal' or 'attention'");
  }

  const status = requireNonEmptyString(payload.status, "payload.status");
  if (expectedStatus && status !== expectedStatus) {
    throw new Error(`execution update payload.status '${status}' does not match event name '${expectedStatus}'`);
  }

  const handoffId = requireNonEmptyString(payload.handoffId, "payload.handoffId");
  const summary = requireNonEmptyString(payload.summary, "payload.summary");
  const handoffArtifactPath = optionalString(payload.handoffArtifactPath, "payload.handoffArtifactPath");
  const handoffArtifactSha256 = optionalString(payload.handoffArtifactSha256, "payload.handoffArtifactSha256");

  if (kind === "terminal") {
    if (!TERMINAL_UPDATE_STATUSES.includes(status as TerminalUpdateStatus)) {
      throw new Error(`terminal execution update status '${status}' is invalid`);
    }
    const filesChanged = normalizeStringArray(payload.filesChanged, "payload.filesChanged", true);
    const validation = parseValidationRecords(payload.validation, true);
    const nextStep = optionalString(payload.nextStep, "payload.nextStep");
    return {
      schema: EXECUTION_UPDATE_SCHEMA,
      kind,
      status: status as TerminalUpdateStatus,
      handoffId,
      summary,
      filesChanged,
      validation,
      ...(nextStep ? { nextStep } : {}),
      ...(handoffArtifactPath ? { handoffArtifactPath } : {}),
      ...(handoffArtifactSha256 ? { handoffArtifactSha256 } : {}),
    };
  }

  if (!ATTENTION_UPDATE_STATUSES.includes(status as AttentionUpdateStatus)) {
    throw new Error(`attention execution update status '${status}' is invalid`);
  }
  const nextStep = requireNonEmptyString(payload.nextStep, "payload.nextStep");
  const blocker = optionalString(payload.blocker, "payload.blocker");
  const question = optionalString(payload.question, "payload.question");
  if (status === "blocker" && !blocker) {
    throw new Error("blocker execution update requires payload.blocker");
  }
  if (status === "clarification_needed" && !question) {
    throw new Error("clarification_needed execution update requires payload.question");
  }
  const filesChanged = normalizeStringArray(payload.filesChanged, "payload.filesChanged", false);
  const validation = parseValidationRecords(payload.validation, false);
  return {
    schema: EXECUTION_UPDATE_SCHEMA,
    kind,
    status: status as AttentionUpdateStatus,
    handoffId,
    summary,
    nextStep,
    ...(blocker ? { blocker } : {}),
    ...(question ? { question } : {}),
    ...(filesChanged.length > 0 ? { filesChanged } : {}),
    ...(validation.length > 0 ? { validation } : {}),
    ...(handoffArtifactPath ? { handoffArtifactPath } : {}),
    ...(handoffArtifactSha256 ? { handoffArtifactSha256 } : {}),
  };
}

function validationLines(records: ValidationRecord[] | undefined): string[] {
  if (!records || records.length === 0) return ["- validation: (none)"];
  return [
    "- validation:",
    ...records.map((record) => `  - ${record.result} — ${truncate(record.command, 160)}${record.details ? ` (${truncate(record.details, 160)})` : ""}`),
  ];
}

function filesChangedLines(filesChanged: string[] | undefined): string[] {
  if (!filesChanged || filesChanged.length === 0) return ["- files changed: (none)"];
  return [
    "- files changed:",
    ...filesChanged.map((path) => `  - ${truncate(path, 200)}`),
  ];
}

export function formatExecutionUpdateMarkdown(
  payload: ExecutionUpdatePayload,
  opts?: { fromLabel?: string; pairId?: string },
): string {
  const fromLabel = opts?.fromLabel ?? "worker";
  const lines = [
    `**${fromLabel} ${payload.status.replace(/_/g, " ")}**`,
    "",
    ...(opts?.pairId ? [`- pair id: ${opts.pairId}`] : []),
    `- handoff id: ${payload.handoffId}`,
    `- summary: ${payload.summary}`,
    ...filesChangedLines(payload.filesChanged),
    ...validationLines(payload.validation),
  ];

  if (payload.kind === "attention") {
    if (payload.blocker) lines.push(`- blocker: ${payload.blocker}`);
    if (payload.question) lines.push(`- question: ${payload.question}`);
    lines.push(`- next step: ${payload.nextStep}`);
  } else if (payload.nextStep) {
    lines.push(`- next step: ${payload.nextStep}`);
  }

  if (payload.handoffArtifactPath) lines.push(`- handoff artifact: ${truncate(payload.handoffArtifactPath, 200)}`);
  if (payload.handoffArtifactSha256) lines.push(`- handoff sha256: ${payload.handoffArtifactSha256}`);
  return lines.join("\n");
}

export function formatExecutionUpdateRelaySummary(payload: ExecutionUpdatePayload): string {
  const lines = [
    `Worker status: ${payload.status.replace(/_/g, " ")}`,
    `Summary: ${payload.summary}`,
  ];
  if (payload.filesChanged && payload.filesChanged.length > 0) {
    lines.push(`Files changed: ${payload.filesChanged.join(", ")}`);
  } else {
    lines.push("Files changed: none");
  }

  if (payload.validation && payload.validation.length > 0) {
    const validationSummary = payload.validation
      .map((record) => `${record.result}:${truncate(record.command, 120)}`)
      .join("; ");
    lines.push(`Validation: ${validationSummary}`);
  } else {
    lines.push("Validation: none");
  }

  if (payload.kind === "attention") {
    if (payload.blocker) lines.push(`Blocker: ${payload.blocker}`);
    if (payload.question) lines.push(`Question: ${payload.question}`);
  }
  if (payload.nextStep) lines.push(`Next step: ${payload.nextStep}`);
  return lines.join("\n");
}

export function formatExecutionUpdateForSupervision(payload: ExecutionUpdatePayload): string {
  return [
    `[${payload.status}] handoff=${payload.handoffId}`,
    `summary: ${payload.summary}`,
    ...(payload.filesChanged && payload.filesChanged.length > 0
      ? [`files_changed: ${payload.filesChanged.join(", ")}`]
      : []),
    ...(payload.validation && payload.validation.length > 0
      ? [
          "validation:",
          ...payload.validation.map((record) => `- ${record.result}: ${record.command}${record.details ? ` (${record.details})` : ""}`),
        ]
      : []),
    ...(payload.kind === "attention" && payload.blocker ? [`blocker: ${payload.blocker}`] : []),
    ...(payload.kind === "attention" && payload.question ? [`question: ${payload.question}`] : []),
    ...(payload.nextStep ? [`next_step: ${payload.nextStep}`] : []),
    ...(payload.handoffArtifactPath ? [`handoff_artifact: ${payload.handoffArtifactPath}`] : []),
  ].join("\n");
}

export function hasFailedValidation(payload: ExecutionUpdatePayload): boolean {
  return payload.validation?.some((record) => record.result === "failed") ?? false;
}

export function buildExecutionUpdatePayload(params: {
  status: HighSignalUpdateStatus;
  handoffId: string;
  summary: string;
  filesChanged?: string[];
  validation?: ValidationRecord[];
  nextStep?: string;
  blocker?: string;
  question?: string;
  handoffArtifactPath?: string;
  handoffArtifactSha256?: string;
}): ExecutionUpdatePayload {
  const base = {
    schema: EXECUTION_UPDATE_SCHEMA,
    handoffId: params.handoffId,
    summary: params.summary.trim(),
    ...(params.handoffArtifactPath ? { handoffArtifactPath: params.handoffArtifactPath } : {}),
    ...(params.handoffArtifactSha256 ? { handoffArtifactSha256: params.handoffArtifactSha256 } : {}),
  } as const;

  if (TERMINAL_UPDATE_STATUSES.includes(params.status as TerminalUpdateStatus)) {
    return parseExecutionUpdatePayload({
      ...base,
      kind: "terminal",
      status: params.status,
      filesChanged: params.filesChanged ?? [],
      validation: params.validation ?? [],
      ...(params.nextStep ? { nextStep: params.nextStep } : {}),
    }, params.status);
  }

  return parseExecutionUpdatePayload({
    ...base,
    kind: "attention",
    status: params.status,
    nextStep: params.nextStep ?? "Waiting for lead guidance.",
    ...(params.blocker ? { blocker: params.blocker } : {}),
    ...(params.question ? { question: params.question } : {}),
    ...(params.filesChanged ? { filesChanged: params.filesChanged } : {}),
    ...(params.validation ? { validation: params.validation } : {}),
  }, params.status);
}
