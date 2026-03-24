import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

export const PLAN_BUILD_SETTINGS_FILE_NAME = "plan-build-settings.yaml";
const PLAN_BUILD_PROJECT_DIR_NAME = ".pi";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type PlanBuildSourceKind = "bundled" | "global" | "project";

export interface PlanBuildSource {
  kind: PlanBuildSourceKind;
  path: string;
}

export interface PlannerSettings {
  model: string;
  thinking: ThinkingLevel;
  allowed_tools: string[];
  prompt_append?: string;
}

export interface BuilderSettings {
  agent_name: string;
  model: string;
  system_prompt_append?: string;
  startup_prompt_append?: string;
}

export interface PlanBuildSettings {
  version: number;
  planner: PlannerSettings;
  builder: BuilderSettings;
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

type PartialPlannerSettings = Partial<PlannerSettings>;
type PartialBuilderSettings = Partial<BuilderSettings>;
type PartialPlanBuildSettings = {
  version?: number;
  planner?: PartialPlannerSettings;
  builder?: PartialBuilderSettings;
};

const TOP_LEVEL_KEYS = new Set(["version", "planner", "builder"]);
const PLANNER_KEYS = new Set(["model", "thinking", "allowed_tools", "prompt_append"]);
const BUILDER_KEYS = new Set(["agent_name", "model", "system_prompt_append", "startup_prompt_append"]);

const raw_settings_schema = z
  .object({
    version: z.unknown().optional(),
    planner: z.unknown().optional(),
    builder: z.unknown().optional(),
  })
  .passthrough();

const raw_planner_schema = z
  .object({
    model: z.unknown().optional(),
    thinking: z.unknown().optional(),
    allowed_tools: z.unknown().optional(),
    prompt_append: z.unknown().optional(),
  })
  .passthrough();

const raw_builder_schema = z
  .object({
    agent_name: z.unknown().optional(),
    model: z.unknown().optional(),
    system_prompt_append: z.unknown().optional(),
    startup_prompt_append: z.unknown().optional(),
  })
  .passthrough();

const thinking_level_schema = z.enum(THINKING_LEVELS);

export const DEFAULT_PLAN_BUILD_SETTINGS: PlanBuildSettings = {
  version: 1,
  planner: {
    model: "anthropic/claude-opus-4-6",
    thinking: "high",
    allowed_tools: ["read", "bash", "grep", "find", "ls", "websearch"],
  },
  builder: {
    agent_name: "builder",
    model: "openai/gpt-5.4:xhigh",
  },
};

interface ParseSourceResult {
  partial: PartialPlanBuildSettings;
  warnings: string[];
  invalid_field_count: number;
  error?: string;
}

export function getDefaultPlanBuildSettings(): PlanBuildSettings {
  return {
    version: DEFAULT_PLAN_BUILD_SETTINGS.version,
    planner: {
      model: DEFAULT_PLAN_BUILD_SETTINGS.planner.model,
      thinking: DEFAULT_PLAN_BUILD_SETTINGS.planner.thinking,
      allowed_tools: [...DEFAULT_PLAN_BUILD_SETTINGS.planner.allowed_tools],
      ...(DEFAULT_PLAN_BUILD_SETTINGS.planner.prompt_append
        ? { prompt_append: DEFAULT_PLAN_BUILD_SETTINGS.planner.prompt_append }
        : {}),
    },
    builder: {
      agent_name: DEFAULT_PLAN_BUILD_SETTINGS.builder.agent_name,
      model: DEFAULT_PLAN_BUILD_SETTINGS.builder.model,
      ...(DEFAULT_PLAN_BUILD_SETTINGS.builder.system_prompt_append
        ? { system_prompt_append: DEFAULT_PLAN_BUILD_SETTINGS.builder.system_prompt_append }
        : {}),
      ...(DEFAULT_PLAN_BUILD_SETTINGS.builder.startup_prompt_append
        ? { startup_prompt_append: DEFAULT_PLAN_BUILD_SETTINGS.builder.startup_prompt_append }
        : {}),
    },
  };
}

export function getDefaultPlanBuildSettingsLoadResult(): PlanBuildSettingsLoadResult {
  return {
    settings: getDefaultPlanBuildSettings(),
    warnings: [],
    stats: {
      loaded_sources: [],
      skipped_sources: [],
      invalid_field_count: 0,
    },
  };
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

  const sources: PlanBuildSource[] = [bundled_source, global_source, ...(project_source ? [project_source] : [])];
  let settings = getDefaultPlanBuildSettings();
  const warnings: string[] = [];
  const skipped_sources: Array<{ source: PlanBuildSource; reason: string }> = [];
  const loaded_sources: PlanBuildSource[] = [];
  let invalid_field_count = 0;

  for (const source of sources) {
    const parsed = await parseSettingsSource(source);
    if (parsed.error) {
      skipped_sources.push({ source, reason: parsed.error });
      if (source.kind === "bundled" || parsed.error !== "file not found") {
        warnings.push(`${source.kind}: ${parsed.error}`);
      }
      continue;
    }

    settings = mergePlanBuildSettings(settings, parsed.partial);
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

  if (parsed.planner !== undefined) {
    const normalizedPlanner = normalizePlannerSettings(parsed.planner, source);
    if (normalizedPlanner.settings) {
      partial.planner = normalizedPlanner.settings;
    }
    warnings.push(...normalizedPlanner.warnings);
    invalid_field_count += normalizedPlanner.invalid_field_count;
  }

  if (parsed.builder !== undefined) {
    const normalizedBuilder = normalizeBuilderSettings(parsed.builder, source);
    if (normalizedBuilder.settings) {
      partial.builder = normalizedBuilder.settings;
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

function normalizePlannerSettings(
  rawPlanner: unknown,
  source: PlanBuildSource,
): { settings?: PartialPlannerSettings; warnings: string[]; invalid_field_count: number } {
  const parsedPlanner = raw_planner_schema.safeParse(rawPlanner ?? {});
  if (!parsedPlanner.success) {
    return {
      warnings: [`${source.kind}: 'planner' must be an object`],
      invalid_field_count: 1,
    };
  }

  const planner = parsedPlanner.data;
  const warnings: string[] = [];
  let invalid_field_count = 0;
  const settings: PartialPlannerSettings = {};

  for (const key of Object.keys(planner)) {
    if (!PLANNER_KEYS.has(key)) {
      warnings.push(`${source.kind}: ignoring unknown planner key '${key}' in ${source.path}`);
    }
  }

  if (planner.model !== undefined) {
    if (typeof planner.model !== "string" || !planner.model.trim()) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'planner.model' must be a non-empty string`);
    } else if (!isProviderModelRef(planner.model.trim())) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'planner.model' must look like 'provider/modelId'`);
    } else {
      settings.model = planner.model.trim();
    }
  }

  if (planner.thinking !== undefined) {
    const thinking = thinking_level_schema.safeParse(planner.thinking);
    if (!thinking.success) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'planner.thinking' must be one of ${THINKING_LEVELS.join(", ")}`);
    } else {
      settings.thinking = thinking.data;
    }
  }

  if (planner.allowed_tools !== undefined) {
    if (!Array.isArray(planner.allowed_tools)) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'planner.allowed_tools' must be an array`);
    } else {
      const allowed_tools: string[] = [];
      for (const value of planner.allowed_tools) {
        if (typeof value !== "string" || !value.trim()) {
          invalid_field_count += 1;
          warnings.push(`${source.kind}: non-empty strings are required in 'planner.allowed_tools'`);
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

  if (planner.prompt_append !== undefined) {
    const prompt_append = normalizeOptionalText(planner.prompt_append);
    if (prompt_append === undefined && typeof planner.prompt_append !== "string") {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'planner.prompt_append' must be a string`);
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

function normalizeBuilderSettings(
  rawBuilder: unknown,
  source: PlanBuildSource,
): { settings?: PartialBuilderSettings; warnings: string[]; invalid_field_count: number } {
  const parsedBuilder = raw_builder_schema.safeParse(rawBuilder ?? {});
  if (!parsedBuilder.success) {
    return {
      warnings: [`${source.kind}: 'builder' must be an object`],
      invalid_field_count: 1,
    };
  }

  const builder = parsedBuilder.data;
  const warnings: string[] = [];
  let invalid_field_count = 0;
  const settings: PartialBuilderSettings = {};

  for (const key of Object.keys(builder)) {
    if (!BUILDER_KEYS.has(key)) {
      warnings.push(`${source.kind}: ignoring unknown builder key '${key}' in ${source.path}`);
    }
  }

  if (builder.agent_name !== undefined) {
    if (typeof builder.agent_name !== "string" || !builder.agent_name.trim()) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'builder.agent_name' must be a non-empty string`);
    } else {
      settings.agent_name = builder.agent_name.trim();
    }
  }

  if (builder.model !== undefined) {
    if (typeof builder.model !== "string" || !builder.model.trim()) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'builder.model' must be a non-empty string`);
    } else {
      settings.model = builder.model.trim();
    }
  }

  if (builder.system_prompt_append !== undefined) {
    const system_prompt_append = normalizeOptionalText(builder.system_prompt_append);
    if (system_prompt_append === undefined && typeof builder.system_prompt_append !== "string") {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'builder.system_prompt_append' must be a string`);
    } else {
      settings.system_prompt_append = system_prompt_append;
    }
  }

  if (builder.startup_prompt_append !== undefined) {
    const startup_prompt_append = normalizeOptionalText(builder.startup_prompt_append);
    if (startup_prompt_append === undefined && typeof builder.startup_prompt_append !== "string") {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'builder.startup_prompt_append' must be a string`);
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
  const plannerHasPromptAppend = !!partial.planner && Object.prototype.hasOwnProperty.call(partial.planner, "prompt_append");
  const builderHasSystemPromptAppend = !!partial.builder && Object.prototype.hasOwnProperty.call(partial.builder, "system_prompt_append");
  const builderHasStartupPromptAppend = !!partial.builder && Object.prototype.hasOwnProperty.call(partial.builder, "startup_prompt_append");

  return {
    version: partial.version ?? base.version,
    planner: {
      model: partial.planner?.model ?? base.planner.model,
      thinking: partial.planner?.thinking ?? base.planner.thinking,
      allowed_tools: partial.planner?.allowed_tools ? [...partial.planner.allowed_tools] : [...base.planner.allowed_tools],
      prompt_append: plannerHasPromptAppend ? partial.planner?.prompt_append : base.planner.prompt_append,
    },
    builder: {
      agent_name: partial.builder?.agent_name ?? base.builder.agent_name,
      model: partial.builder?.model ?? base.builder.model,
      system_prompt_append: builderHasSystemPromptAppend ? partial.builder?.system_prompt_append : base.builder.system_prompt_append,
      startup_prompt_append: builderHasStartupPromptAppend ? partial.builder?.startup_prompt_append : base.builder.startup_prompt_append,
    },
  };
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
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
