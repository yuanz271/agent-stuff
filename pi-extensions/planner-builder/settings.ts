import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

export const PLANNER_BUILDER_SETTINGS_FILE_NAME = "planner-builder-settings.yaml";
const PLANNER_BUILDER_PROJECT_DIR_NAME = ".pi";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type PlannerBuilderSourceKind = "bundled" | "global" | "project";

export interface PlannerBuilderSource {
  kind: PlannerBuilderSourceKind;
  path: string;
}

export interface PlannerSettings {
  model: string;
  thinking: ThinkingLevel;
  allowed_tools: string[];
  prompt_append?: string;
}

export interface BuilderSettings {
  model: string;
  thinking: ThinkingLevel;
  system_prompt_append?: string;
  startup_prompt_append?: string;
}

export interface PlannerBuilderSettings {
  version: number;
  planner: PlannerSettings;
  builder: BuilderSettings;
}

export interface PlannerBuilderSettingsStats {
  loaded_sources: PlannerBuilderSource[];
  skipped_sources: Array<{ source: PlannerBuilderSource; reason: string }>;
  invalid_field_count: number;
}

export interface PlannerBuilderSettingsLoadResult {
  settings: PlannerBuilderSettings;
  warnings: string[];
  stats: PlannerBuilderSettingsStats;
}

type PartialPlannerSettings = Partial<PlannerSettings>;
type PartialBuilderSettings = Partial<BuilderSettings>;
type PartialPlannerBuilderSettings = {
  version?: number;
  planner?: PartialPlannerSettings;
  builder?: PartialBuilderSettings;
};

const TOP_LEVEL_KEYS = new Set(["version", "planner", "builder"]);
const PLANNER_KEYS = new Set(["model", "thinking", "allowed_tools", "prompt_append"]);
const BUILDER_KEYS = new Set(["model", "thinking", "system_prompt_append", "startup_prompt_append"]);

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
    model: z.unknown().optional(),
    thinking: z.unknown().optional(),
    system_prompt_append: z.unknown().optional(),
    startup_prompt_append: z.unknown().optional(),
  })
  .passthrough();

const thinking_level_schema = z.enum(THINKING_LEVELS);

interface ParseSourceResult {
  partial: PartialPlannerBuilderSettings;
  warnings: string[];
  invalid_field_count: number;
  error?: string;
}

export async function loadPlannerBuilderSettings(cwd: string, importMetaUrl: string): Promise<PlannerBuilderSettingsLoadResult> {
  const bundled_source: PlannerBuilderSource = {
    kind: "bundled",
    path: getBundledSettingsPath(importMetaUrl),
  };
  const global_source: PlannerBuilderSource = {
    kind: "global",
    path: path.join(getAgentDir(), PLANNER_BUILDER_SETTINGS_FILE_NAME),
  };
  const discovered_project_path = findProjectSettingsPath(cwd);
  const project_source: PlannerBuilderSource | undefined = discovered_project_path
    ? {
        kind: "project",
        path: discovered_project_path,
      }
    : undefined;

  const bundled = await parseSettingsSource(bundled_source);
  if (bundled.error) {
    throw new Error(`required bundled planner-builder settings failed (${bundled_source.path}): ${bundled.error}`);
  }

  let settings = finalizePlannerBuilderSettings(bundled.partial, `bundled planner-builder settings (${bundled_source.path})`);
  const warnings: string[] = [...bundled.warnings];
  const skipped_sources: Array<{ source: PlannerBuilderSource; reason: string }> = [];
  const loaded_sources: PlannerBuilderSource[] = [bundled_source];
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

    settings = finalizePlannerBuilderSettings(
      mergePlannerBuilderSettings(settings, parsed.partial),
      `planner-builder settings after applying ${source.kind} overrides`,
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

async function parseSettingsSource(source: PlannerBuilderSource): Promise<ParseSourceResult> {
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
  const partial: PartialPlannerBuilderSettings = {};

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
  source: PlannerBuilderSource,
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
  source: PlannerBuilderSource,
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
  let shorthandThinking: ThinkingLevel | undefined;

  for (const key of Object.keys(builder)) {
    if (!BUILDER_KEYS.has(key)) {
      warnings.push(`${source.kind}: ignoring unknown builder key '${key}' in ${source.path}`);
    }
  }

  if (builder.model !== undefined) {
    if (typeof builder.model !== "string" || !builder.model.trim()) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'builder.model' must be a non-empty string`);
    } else {
      const normalizedModel = splitModelThinkingShorthand(builder.model.trim());
      if (!isProviderModelRef(normalizedModel.model)) {
        invalid_field_count += 1;
        warnings.push(`${source.kind}: 'builder.model' must look like 'provider/modelId'`);
      } else {
        settings.model = normalizedModel.model;
        shorthandThinking = normalizedModel.thinking;
      }
    }
  }

  if (builder.thinking !== undefined) {
    const thinking = thinking_level_schema.safeParse(builder.thinking);
    if (!thinking.success) {
      invalid_field_count += 1;
      warnings.push(`${source.kind}: 'builder.thinking' must be one of ${THINKING_LEVELS.join(", ")}`);
    } else {
      settings.thinking = thinking.data;
      if (shorthandThinking && shorthandThinking !== thinking.data) {
        warnings.push(
          `${source.kind}: builder.model includes legacy thinking suffix '${shorthandThinking}', but explicit builder.thinking '${thinking.data}' takes precedence`,
        );
      }
    }
  } else if (shorthandThinking) {
    settings.thinking = shorthandThinking;
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

function mergePlannerBuilderSettings(base: PlannerBuilderSettings, partial: PartialPlannerBuilderSettings): PlannerBuilderSettings {
  // hasOwnProperty distinguishes "field absent" (keep base value) from
  // "field explicitly set to undefined" (clear the value).  This matters
  // for optional text fields that a project layer may want to remove.
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
      model: partial.builder?.model ?? base.builder.model,
      thinking: partial.builder?.thinking ?? base.builder.thinking,
      system_prompt_append: builderHasSystemPromptAppend ? partial.builder?.system_prompt_append : base.builder.system_prompt_append,
      startup_prompt_append: builderHasStartupPromptAppend ? partial.builder?.startup_prompt_append : base.builder.startup_prompt_append,
    },
  };
}

function finalizePlannerBuilderSettings(settings: PartialPlannerBuilderSettings, context: string): PlannerBuilderSettings {
  const missing: string[] = [];
  const version = settings.version;
  const planner = settings.planner;
  const builder = settings.builder;

  if (typeof version !== "number" || !Number.isFinite(version)) missing.push("version");
  if (!planner?.model) missing.push("planner.model");
  if (!planner?.thinking) missing.push("planner.thinking");
  if (!Array.isArray(planner?.allowed_tools)) missing.push("planner.allowed_tools");
  if (!builder?.model) missing.push("builder.model");
  if (!builder?.thinking) missing.push("builder.thinking");

  if (missing.length > 0) {
    throw new Error(`${context} is incomplete: missing ${missing.join(", ")}`);
  }

  const completeVersion = version as number;
  const completePlanner = planner as PlannerSettings;
  const completeBuilder = builder as BuilderSettings;

  if (!isProviderModelRef(completePlanner.model)) {
    throw new Error(`${context} is invalid: planner.model must look like 'provider/modelId'`);
  }
  if (!isProviderModelRef(completeBuilder.model)) {
    throw new Error(`${context} is invalid: builder.model must look like 'provider/modelId'`);
  }

  return {
    version: completeVersion,
    planner: {
      model: completePlanner.model,
      thinking: completePlanner.thinking,
      allowed_tools: [...completePlanner.allowed_tools],
      ...(completePlanner.prompt_append !== undefined ? { prompt_append: completePlanner.prompt_append } : {}),
    },
    builder: {
      model: completeBuilder.model,
      thinking: completeBuilder.thinking,
      ...(completeBuilder.system_prompt_append !== undefined ? { system_prompt_append: completeBuilder.system_prompt_append } : {}),
      ...(completeBuilder.startup_prompt_append !== undefined ? { startup_prompt_append: completeBuilder.startup_prompt_append } : {}),
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
  return path.join(path.dirname(filePath), PLANNER_BUILDER_SETTINGS_FILE_NAME);
}

function findProjectSettingsPath(cwd: string): string | undefined {
  const startDir = path.resolve(cwd);
  const gitRoot = findGitRoot(startDir);
  const fsRoot = path.parse(startDir).root;

  let current = startDir;
  while (true) {
    const candidate = path.join(current, PLANNER_BUILDER_PROJECT_DIR_NAME, PLANNER_BUILDER_SETTINGS_FILE_NAME);
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
