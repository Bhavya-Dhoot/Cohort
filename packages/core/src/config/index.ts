import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
  AgentsFileSchema,
  MemoryFileSchema,
  ModelsFileSchema,
  OrchestratorFileSchema,
  ProvidersFileSchema,
  type OrchestratorConfig
} from "./schema.js";

export type { OrchestratorConfig } from "./schema.js";

/**
 * Loads and validates the five Agentic OS config files.
 *
 * Each `<name>.yaml` is read from `defaultsDir` (all five are required
 * there). If `overridesDir` is given and contains a same-named file, it is
 * deep-merged over the default: plain objects merge key-by-key recursively,
 * arrays and scalars replace outright. `${VAR}` placeholders in any string
 * value are then interpolated from `process.env` (an unset var throws), and
 * the result is validated against that file's zod schema.
 */
export async function loadConfig(
  defaultsDir: string,
  overridesDir?: string
): Promise<OrchestratorConfig> {
  const [orchestrator, models, agents, memory, providers] = await Promise.all([
    loadFile("orchestrator", OrchestratorFileSchema, defaultsDir, overridesDir),
    loadFile("models", ModelsFileSchema, defaultsDir, overridesDir),
    loadFile("agents", AgentsFileSchema, defaultsDir, overridesDir),
    loadFile("memory", MemoryFileSchema, defaultsDir, overridesDir),
    loadFile("providers", ProvidersFileSchema, defaultsDir, overridesDir)
  ]);

  return { orchestrator, models, agents, memory, providers };
}

/**
 * Resolves a task's `taskType` to a "provider/model" string via
 * `models.routing`, falling back to `routing.default` when `taskType` is
 * unset or has no dedicated route. The returned string is passed through
 * unmodified — no provider names live in code, only in config.
 */
export function resolveModelRoute(config: OrchestratorConfig, taskType?: string): string {
  const routing = config.models.routing;
  if (taskType !== undefined && Object.hasOwn(routing, taskType)) {
    return routing[taskType];
  }
  return routing.default;
}

async function loadFile<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  defaultsDir: string,
  overridesDir: string | undefined
): Promise<z.infer<Schema>> {
  const defaultPath = join(defaultsDir, `${name}.yaml`);
  const defaultRaw = await readYamlIfExists(defaultPath);
  if (defaultRaw === undefined) {
    throw new Error(`Missing required config file: ${defaultPath}`);
  }

  let merged: unknown = defaultRaw;
  if (overridesDir) {
    const overridePath = join(overridesDir, `${name}.yaml`);
    const overrideRaw = await readYamlIfExists(overridePath);
    if (overrideRaw !== undefined) {
      merged = deepMerge(defaultRaw, overrideRaw);
    }
  }

  const interpolated = interpolate(merged, name);
  const result = schema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config in ${name}.yaml:\n${issues}`);
  }
  return result.data;
}

/** Reads and parses `path` as YAML, returning `undefined` if it doesn't exist. */
async function readYamlIfExists(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    return parseYaml(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges `override` over `base`: objects merge, arrays/scalars replace. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(base[key], override[key]);
    }
    return result;
  }
  return override;
}

/** Replaces `${VAR}` in every string leaf with `process.env.VAR`; throws if unset. */
function interpolate(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const envValue = process.env[name];
      if (envValue === undefined) {
        throw new Error(
          `Config interpolation error at ${path}: environment variable "${name}" is not set`
        );
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolate(item, `${path}[${i}]`));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = interpolate(item, `${path}.${key}`);
    }
    return result;
  }
  return value;
}
