import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

export const PLAN_BUILD_SETTINGS_FILE_NAME = "lead-worker-settings.yaml";
const PLAN_BUILD_PROJECT_DIR_NAME = ".pi";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type PlanBuildSourceKind = "bundled" | "global" | "project";

export interface PlanBuildSource {
  kind: PlanBuildSourceKind;
  path: string;
}

export interface LeadSettings {
  model: string;
  thinking: ThinkingLevel;
  allowed_tools: string[];
  prompt_append?: string;
}

export interface WorkerSettings {
  model: string;
  thinking: ThinkingLevel;
  system_prompt_append?: string;
  startup_prompt_append?: string;
}

export interface PlanBuildSettings {
  version: number;
  lead: LeadSettings;
  worker: WorkerSettings;
}

export interface PlanBuildSettingsStats {
  loaded_sources: PlanBuildSource[];
  skipped_sources: Array<{ source: PlanBuildSource; reason: string }>;
  invalid_field_count: number;
}

export interface PlanBuildSettingsLoadResult {
  settings: PlanBuildSettings;
  warnings: string[];
  stats: PlanBuildSettingsStats;
}

type PartialLeadSettings = Partial<LeadSettings>;
type PartialWorkerSettings = Partial<WorkerSettings>;
type PartialPlanBuildSettings = {
  version?: number;
  lead?: PartialLeadSettings;
  worker?: PartialWorkerSettings;
};

const TOP_LEVEL_KEYS = new Set(["version", "lead", "worker"]);
const PLANNER_KEYS = new Set(["model", "thinking", "allowed_tools", "prompt_append"]);
const BUILDER_KEYS = new Set(["model", "thinking", "system_prompt_append", "startup_prompt_append"]);

const raw_settings_schema = z
  .object({
    version: z.unknown().optional(),
    lead: z.unknown().optional(),
    worker: z.unknown().optional(),
  })
  .passthrough();

const raw_lead_schema = z
  .object({
    model: z.unknown().optional(),
    thinking: z.unknown().optional(),
    allowed_tools: z.unknown().optional(),
    prompt_append: z.unknown().optional(),
  })
  .passthrough();

const raw_worker_schema = z
  .object({
    model: z.unknown().optional(),
    thinking: z.unknown().optional(),
    system_prompt_append: z.unknown().optional(),
    startup_prompt_append: z.unknown().optional(),
  })
  .passthrough();

const thinking_level_schema = z.enum(THINKING_LEVELS);

interface ParseSourceResult {
  partial: PartialPlanBuildSettings;
  warnings: string[];
  invalid_field_count: number;
  error?: string;
}

export async function loadPlanBuildSettings(cwd: string, importMetaUrl: string): Promise<PlanBuildSettingsLoadResult> {
  const bundled_source: PlanBuildSource = {
    kind: "bundled",
    path: getBundledSettingsPath(importMetaUrl),
  };
  const global_source: PlanBuildSource = {
    kind: "global",
    path: path.join(getAgentDir(), PLAN_BUILD_SETTINGS_FILE_NAME),
  };
  const discovered_project_path = findProjectSettingsPath(cwd);
  const project_source: PlanBuildSource | undefined = discovered_project_path
    ? {
        kind: "project",
        path: discovered_project_path,
      }
    : undefined;

  const bundled = await parseSettingsSource(bundled_source);
  if (bundled.error) {
    throw new Error(`required bundled lead-worker settings failed (${bundled_source.path}): ${bundled.error}`);
  }

  let settings = finalizePlanBuildSettings(bundled.partial, `bundled lead-worker settings (${bundled_source.path})`);
  const warnings: string[] = [...bundled.warnings];
  const skipped_sources: Array<{ source: PlanBuildSource; reason: string }> = [];
  const loaded_sources: PlanBuildSource[] = [bundled_source];
  let invalid_field_count = bundled.invalid_field_count;

  for (const source of [global_source, ...(project_source ? [project_source] : [])]) {
    const parsed = await parseSettingsSource(source);
    if (parsed.error) {
      skipped_sources.push({ source, reason: parsed.error });
      if (parsed.error !== "file not found") {
        warnings.push(`${source.kind}: ${parsed.error}`);
      }
      continue;
    }

    settings = finalizePlanBuildSettings(
      mergePlanBuildSettings(settings, parsed.partial),
      `lead-worker settings after applying ${source.kind} overrides`,
    );
    loaded_sources.push(source);
    warnings.push(...parsed.warnings);
    invalid_field_count += parsed.invalid_field_count;
  }

  return {
    settings,
    warnings,
    stats: {
      loaded_sources,
      skipped_sources,
      invalid_field_count,
    },
  };
}

async function parseSettingsSource(source: PlanBuildSource): Promise<ParseSourceResult> {
  const empty: ParseSourceResult = {
    partial: {},
    warnings: [],
    invalid_field_count: 0,
  };

  if (!existsSync(source.path)) {
    return { ...empty, error: "file not found" };
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(source.path, "utf8");
  } catch (error: any) {
    return { ...empty, error: `read failed: ${error?.message ?? "unknown error"}` };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = YAML.parse(rawText);
  } catch (error: any) {
    return { ...empty, error: `yaml parse failed: ${error?.message ?? "unknown error"}` };
  }

  const parsedResult = raw_settings_schema.safeParse(parsedRaw ?? {});
  if (!parsedResult.success) {
    return { ...empty, error: "yaml root is not an object" };
  }
  const parsed = parsedResult.data;

  const warnings: string[] = [];
  let invalid_field_count = 0;
  const partial: PartialPlanBuildSettings = {};

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`${source.kind}: ignoring unknown key '${key}' in ${source.path}`);
    }
  }

  if (parsed.version !== undefined) {
    if (typeof parsed.version === "number" && Number.isFinite(parsed.version)) {
      partial.version = parsed.version;
    } else {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'version' must be a number`);
    }
  }

  if (parsed.lead !== undefined) {
    const normalizedPlanner = normalizeLeadSettings(parsed.lead, source);
    if (normalizedPlanner.settings) {
      partial.lead = normalizedPlanner.settings;
    }
    warnings.push(...normalizedPlanner.warnings);
    invalid_field_count += normalizedPlanner.invalid_field_count;
  }

  if (parsed.worker !== undefined) {
    const normalizedBuilder = normalizeWorkerSettings(parsed.worker, source);
    if (normalizedBuilder.settings) {
      partial.worker = normalizedBuilder.settings;
    }
    warnings.push(...normalizedBuilder.warnings);
    invalid_field_count += normalizedBuilder.invalid_field_count;
  }

  return {
    partial,
    warnings,
    invalid_field_count,
  };
}

function normalizeLeadSettings(
  rawPlanner: unknown,
  source: PlanBuildSource,
): { settings?: PartialLeadSettings; warnings: string[]; invalid_field_count: number } {
  const parsedPlanner = raw_lead_schema.safeParse(rawPlanner ?? {});
  if (!parsedPlanner.success) {
    return {
      warnings: [`${source.kind}: 'lead' must be an object`],
      invalid_field_count: 1,
    };
  }

  const lead = parsedPlanner.data;
  const warnings: string[] = [];
  let invalid_field_count = 0;
  const settings: PartialLeadSettings = {};

  for (const key of Object.keys(lead)) {
    if (!PLANNER_KEYS.has(key)) {
      warnings.push(`${source.kind}: ignoring unknown lead key '${key}' in ${source.path}`);
    }
  }

  if (lead.model !== undefined) {
    if (typeof lead.model !== "string" || !lead.model.trim()) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'lead.model' must be a non-empty string`);
    } else if (!isProviderModelRef(lead.model.trim())) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'lead.model' must look like 'provider/modelId'`);
    } else {
      settings.model = lead.model.trim();
    }
  }

  if (lead.thinking !== undefined) {
    const thinking = thinking_level_schema.safeParse(lead.thinking);
    if (!thinking.success) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'lead.thinking' must be one of ${THINKING_LEVELS.join(", ")}`);
    } else {
      settings.thinking = thinking.data;
    }
  }

  if (lead.allowed_tools !== undefined) {
    if (!Array.isArray(lead.allowed_tools)) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'lead.allowed_tools' must be an array`);
    } else {
      const allowed_tools: string[] = [];
      for (const value of lead.allowed_tools) {
        if (typeof value !== "string" || !value.trim()) {
          invalid_field_count += 1;
          warnings.push(`${source.kind}: non-empty strings are required in 'lead.allowed_tools'`);
          continue;
        }
        const normalized = value.trim();
        if (!allowed_tools.includes(normalized)) {
          allowed_tools.push(normalized);
        }
      }
      settings.allowed_tools = allowed_tools;
    }
  }

  if (lead.prompt_append !== undefined) {
    const prompt_append = normalizeOptionalText(lead.prompt_append);
    if (prompt_append === undefined && typeof lead.prompt_append !== "string") {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'lead.prompt_append' must be a string`);
    } else {
      settings.prompt_append = prompt_append;
    }
  }

  return {
    settings,
    warnings,
    invalid_field_count,
  };
}

function normalizeWorkerSettings(
  rawBuilder: unknown,
  source: PlanBuildSource,
): { settings?: PartialWorkerSettings; warnings: string[]; invalid_field_count: number } {
  const parsedBuilder = raw_worker_schema.safeParse(rawBuilder ?? {});
  if (!parsedBuilder.success) {
    return {
      warnings: [`${source.kind}: 'worker' must be an object`],
      invalid_field_count: 1,
    };
  }

  const worker = parsedBuilder.data;
  const warnings: string[] = [];
  let invalid_field_count = 0;
  const settings: PartialWorkerSettings = {};
  let shorthandThinking: ThinkingLevel | undefined;

  for (const key of Object.keys(worker)) {
    if (!BUILDER_KEYS.has(key)) {
      warnings.push(`${source.kind}: ignoring unknown worker key '${key}' in ${source.path}`);
    }
  }

  if (worker.model !== undefined) {
    if (typeof worker.model !== "string" || !worker.model.trim()) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'worker.model' must be a non-empty string`);
    } else {
      const normalizedModel = splitModelThinkingShorthand(worker.model.trim());
      if (!isProviderModelRef(normalizedModel.model)) {
        invalid_field_count += 1;
        warnings.push(`${source.kind}: 'worker.model' must look like 'provider/modelId'`);
      } else {
        settings.model = normalizedModel.model;
        shorthandThinking = normalizedModel.thinking;
      }
    }
  }

  if (worker.thinking !== undefined) {
    const thinking = thinking_level_schema.safeParse(worker.thinking);
    if (!thinking.success) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'worker.thinking' must be one of ${THINKING_LEVELS.join(", ")}`);
    } else {
      settings.thinking = thinking.data;
      if (shorthandThinking && shorthandThinking !== thinking.data) {
        warnings.push(
          `${source.kind}: worker.model includes legacy thinking suffix '${shorthandThinking}', but explicit worker.thinking '${thinking.data}' takes precedence`,
        );
      }
    }
  } else if (shorthandThinking) {
    settings.thinking = shorthandThinking;
  }

  if (worker.system_prompt_append !== undefined) {
    const system_prompt_append = normalizeOptionalText(worker.system_prompt_append);
    if (system_prompt_append === undefined && typeof worker.system_prompt_append !== "string") {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'worker.system_prompt_append' must be a string`);
    } else {
      settings.system_prompt_append = system_prompt_append;
    }
  }

  if (worker.startup_prompt_append !== undefined) {
    const startup_prompt_append = normalizeOptionalText(worker.startup_prompt_append);
    if (startup_prompt_append === undefined && typeof worker.startup_prompt_append !== "string") {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'worker.startup_prompt_append' must be a string`);
    } else {
      settings.startup_prompt_append = startup_prompt_append;
    }
  }

  return {
    settings,
    warnings,
    invalid_field_count,
  };
}

function mergePlanBuildSettings(base: PlanBuildSettings, partial: PartialPlanBuildSettings): PlanBuildSettings {
  // hasOwnProperty distinguishes "field absent" (keep base value) from
  // "field explicitly set to undefined" (clear the value).  This matters
  // for optional text fields that a project layer may want to remove.
  const leadHasPromptAppend = !!partial.lead && Object.prototype.hasOwnProperty.call(partial.lead, "prompt_append");
  const workerHasSystemPromptAppend = !!partial.worker && Object.prototype.hasOwnProperty.call(partial.worker, "system_prompt_append");
  const workerHasStartupPromptAppend = !!partial.worker && Object.prototype.hasOwnProperty.call(partial.worker, "startup_prompt_append");

  return {
    version: partial.version ?? base.version,
    lead: {
      model: partial.lead?.model ?? base.lead.model,
      thinking: partial.lead?.thinking ?? base.lead.thinking,
      allowed_tools: partial.lead?.allowed_tools ? [...partial.lead.allowed_tools] : [...base.lead.allowed_tools],
      prompt_append: leadHasPromptAppend ? partial.lead?.prompt_append : base.lead.prompt_append,
    },
    worker: {
      model: partial.worker?.model ?? base.worker.model,
      thinking: partial.worker?.thinking ?? base.worker.thinking,
      system_prompt_append: workerHasSystemPromptAppend ? partial.worker?.system_prompt_append : base.worker.system_prompt_append,
      startup_prompt_append: workerHasStartupPromptAppend ? partial.worker?.startup_prompt_append : base.worker.startup_prompt_append,
    },
  };
}

function finalizePlanBuildSettings(settings: PartialPlanBuildSettings, context: string): PlanBuildSettings {
  const missing: string[] = [];
  const version = settings.version;
  const lead = settings.lead;
  const worker = settings.worker;

  if (typeof version !== "number" || !Number.isFinite(version)) missing.push("version");
  if (!lead?.model) missing.push("lead.model");
  if (!lead?.thinking) missing.push("lead.thinking");
  if (!Array.isArray(lead?.allowed_tools)) missing.push("lead.allowed_tools");
  if (!worker?.model) missing.push("worker.model");
  if (!worker?.thinking) missing.push("worker.thinking");

  if (missing.length > 0) {
    throw new Error(`${context} is incomplete: missing ${missing.join(", ")}`);
  }

  const completeVersion = version as number;
  const completeLead = lead as LeadSettings;
  const completeWorker = worker as WorkerSettings;

  if (!isProviderModelRef(completeLead.model)) {
    throw new Error(`${context} is invalid: lead.model must look like 'provider/modelId'`);
  }
  if (!isProviderModelRef(completeWorker.model)) {
    throw new Error(`${context} is invalid: worker.model must look like 'provider/modelId'`);
  }

  return {
    version: completeVersion,
    lead: {
      model: completeLead.model,
      thinking: completeLead.thinking,
      allowed_tools: [...completeLead.allowed_tools],
      ...(completeLead.prompt_append !== undefined ? { prompt_append: completeLead.prompt_append } : {}),
    },
    worker: {
      model: completeWorker.model,
      thinking: completeWorker.thinking,
      ...(completeWorker.system_prompt_append !== undefined ? { system_prompt_append: completeWorker.system_prompt_append } : {}),
      ...(completeWorker.startup_prompt_append !== undefined ? { startup_prompt_append: completeWorker.startup_prompt_append } : {}),
    },
  };
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function splitModelThinkingShorthand(value: string): { model: string; thinking?: ThinkingLevel } {
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= value.indexOf("/")) {
    return { model: value };
  }

  const candidateModel = value.slice(0, lastColon);
  const candidateThinking = value.slice(lastColon + 1);
  const parsedThinking = thinking_level_schema.safeParse(candidateThinking);
  if (!parsedThinking.success || !isProviderModelRef(candidateModel)) {
    return { model: value };
  }

  return {
    model: candidateModel,
    thinking: parsedThinking.data,
  };
}

function isProviderModelRef(value: string): boolean {
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

function getBundledSettingsPath(importMetaUrl: string): string {
  const filePath = fileURLToPath(importMetaUrl);
  return path.join(path.dirname(filePath), PLAN_BUILD_SETTINGS_FILE_NAME);
}

function findProjectSettingsPath(cwd: string): string | undefined {
  const startDir = path.resolve(cwd);
  const gitRoot = findGitRoot(startDir);
  const fsRoot = path.parse(startDir).root;

  let current = startDir;
  while (true) {
    const candidate = path.join(current, PLAN_BUILD_PROJECT_DIR_NAME, PLAN_BUILD_SETTINGS_FILE_NAME);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (gitRoot && current === gitRoot) break;
    if (!gitRoot && current === fsRoot) break;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

function findGitRoot(startDir: string): string | undefined {
  let current = startDir;
  const fsRoot = path.parse(startDir).root;

  while (true) {
    const gitPath = path.join(current, ".git");
    if (existsSync(gitPath)) {
      return current;
    }
    if (current === fsRoot) break;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}
