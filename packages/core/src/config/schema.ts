import { z } from "zod";

/**
 * Zod schemas for the five shipped config files under `config/` (and their
 * per-project overrides under `<project>/.cohort/config/`). Each schema
 * validates one YAML file after defaults+override merge and `${VAR}` env
 * interpolation — see `./index.ts` for the loader that drives them.
 */

// ---------------------------------------------------------------------------
// orchestrator.yaml
// ---------------------------------------------------------------------------

export const OrchestratorFileSchema = z.object({
  budget: z.object({
    softCapUsd: z.number().positive(),
    hardCapUsd: z.number().positive()
  }),
  replan: z.object({
    maxIterations: z.number().int().nonnegative()
  }),
  humanGates: z.object({
    planApproval: z.boolean(),
    preMerge: z.boolean()
  }),
  worker: z.object({
    maxConcurrent: z.number().int().positive(),
    timeoutMinutes: z.number().positive(),
    infraRetryMax: z.number().int().nonnegative()
  }),
  worktree: z.object({
    /** null means "sibling of the project directory". */
    baseDir: z.string().nullable()
  }),
  /**
   * Named multi-command check suites (lint/typecheck/test/etc.), consumed by
   * `checks/runCheckSuite`. Optional so configs/tests without a `checks` key
   * still validate — a project that omits it simply has no named suites.
   */
  checks: z
    .object({
      suites: z.record(
        z.string(),
        z.array(
          z.object({
            name: z.string(),
            command: z.string(),
            timeoutMs: z.number().int().positive().optional()
          })
        )
      ),
      usage: z
        .object({
          verify: z.string().optional(),
          integration: z.string().optional(),
          regression: z.string().optional()
        })
        .optional()
    })
    .optional()
});
export type OrchestratorFile = z.infer<typeof OrchestratorFileSchema>;

// ---------------------------------------------------------------------------
// models.yaml
// ---------------------------------------------------------------------------

/** `default` is required; any other taskType -> "provider/model" is allowed. */
const ModelRoutingSchema = z.object({ default: z.string() }).catchall(z.string());

export const ModelsFileSchema = z.object({
  routing: ModelRoutingSchema,
  downgrade_on_soft_cap: z.string().optional(),
  small_model: z.string().optional()
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

// ---------------------------------------------------------------------------
// agents.yaml
// ---------------------------------------------------------------------------

const PermissionRulesSchema = z.object({
  /** Command glob patterns denied regardless of per-project overrides. */
  deny: z.array(z.string())
});

export const AgentsFileSchema = z.object({
  archetypes: z.array(z.record(z.string(), z.unknown())),
  default_permission: PermissionRulesSchema,
  max_concurrent_specialists: z.number().int().positive()
});
export type AgentsFile = z.infer<typeof AgentsFileSchema>;

// ---------------------------------------------------------------------------
// memory.yaml
// ---------------------------------------------------------------------------

export const MemoryFileSchema = z.object({
  store: z.string(),
  retention: z.object({
    decisions: z.string()
  }),
  maxContextTokensPerHandoff: z.number().int().positive(),
  /** null means handoff context is passed through unsummarized. */
  summarizationModel: z.string().nullable(),
  /**
   * Extension seam for `memory/index.ts`'s `openMemoryStore(dir, {sections})`
   * option: additional section names a project wants the `memory` tool to
   * accept beyond the built-in defaults, with no code change. Optional so
   * existing configs without this key still validate.
   */
  sections: z.array(z.string()).optional()
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

// ---------------------------------------------------------------------------
// providers.yaml
// ---------------------------------------------------------------------------

const ProviderEntrySchema = z
  .object({
    /** Name of the env var holding the API key — never a literal key. */
    apiKeyEnv: z.string()
  })
  .catchall(z.unknown());

export const ProvidersFileSchema = z.object({
  providers: z.record(z.string(), ProviderEntrySchema),
  opencode_binary_path: z.string()
});
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

// ---------------------------------------------------------------------------
// Merged config
// ---------------------------------------------------------------------------

/** The validated, merged shape returned by `loadConfig`. */
export interface OrchestratorConfig {
  orchestrator: OrchestratorFile;
  models: ModelsFile;
  agents: AgentsFile;
  memory: MemoryFile;
  providers: ProvidersFile;
}
