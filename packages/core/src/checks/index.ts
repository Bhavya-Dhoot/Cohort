/**
 * Named multi-command check suites (lint/typecheck/test/etc.) wrapping
 * `verify/runVerification`. A suite is an ordered list of named commands;
 * running it executes each command in the worker's worktree and aggregates
 * pass/fail, without reimplementing process spawning — that stays in
 * `verify/`, the only source of truth for "did a command actually succeed".
 *
 * Suites and the per-phase `usage` mapping come from `orchestrator.yaml`'s
 * `checks:` key (see `config/schema.ts`).
 */

import { runVerification, type RunVerificationOptions, type VerifyResult } from "../verify/index.js";

/** One named command within a suite, as configured in `orchestrator.yaml`. */
export interface CheckDefinition {
  name: string;
  command: string;
  timeoutMs?: number;
}

/** Result of running a single check's command. */
export interface CheckResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Tail of stdout+stderr, capped to ~2000 chars — evidence, not a full log. */
  outputExcerpt: string;
}

/** Aggregate result of running every check in a suite. */
export interface CheckSuiteResult {
  suiteName: string;
  /** True only if every check in `checks` passed. */
  passed: boolean;
  checks: CheckResult[];
  /** Names of checks that failed (in run order). */
  failed: string[];
  durationMs: number;
}

/** Test seam matching `runVerification`'s signature. */
export type RunVerificationFn = (opts: RunVerificationOptions) => Promise<VerifyResult>;

export interface RunCheckSuiteOptions {
  /** Working directory to run every check's command in. */
  cwd: string;
  /** Key into `suites` identifying which suite to run. */
  suiteName: string;
  /** All configured suites, e.g. `config.orchestrator.checks.suites`. */
  suites: Record<string, CheckDefinition[]>;
  /**
   * When true, stop running further checks as soon as one fails: the suite
   * is still reported `passed: false`, but only the checks that actually ran
   * appear in `checks`/`failed` — there is no synthetic "not run" entry for
   * the rest. Default false (run every check regardless of earlier failures,
   * so a single suite run reports the full picture).
   */
  stopOnFirstFailure?: boolean;
  /** Test seam: overrides `runVerification`. Defaults to the real one. */
  runVerificationFn?: RunVerificationFn;
}

const OUTPUT_EXCERPT_MAX_CHARS = 2000;

/**
 * Looks up `suiteName` in `suites` and runs its checks in order via
 * `runVerification` (or the injected `runVerificationFn`), aggregating the
 * results. Throws if `suiteName` isn't configured, listing the available
 * suite names so the caller can fix a config/usage mismatch immediately.
 */
export async function runCheckSuite(opts: RunCheckSuiteOptions): Promise<CheckSuiteResult> {
  const { cwd, suiteName, suites, stopOnFirstFailure = false } = opts;
  const runVerificationFn = opts.runVerificationFn ?? runVerification;

  const definitions = suites[suiteName];
  if (definitions === undefined) {
    const available = Object.keys(suites).sort().join(", ") || "(none configured)";
    throw new Error(`Unknown check suite "${suiteName}". Available suites: ${available}`);
  }

  const startedAt = Date.now();
  const checks: CheckResult[] = [];
  const failed: string[] = [];

  for (const def of definitions) {
    const result = await runVerificationFn({
      cwd,
      command: def.command,
      timeoutMs: def.timeoutMs
    });

    const checkResult: CheckResult = {
      name: def.name,
      passed: result.passed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputExcerpt: excerpt(result.stdout, result.stderr)
    };
    checks.push(checkResult);

    if (!checkResult.passed) {
      failed.push(def.name);
      if (stopOnFirstFailure) break;
    }
  }

  return {
    suiteName,
    passed: failed.length === 0,
    checks,
    failed,
    durationMs: Date.now() - startedAt
  };
}

/** Tail of `stdout` + `stderr` concatenated, capped to `OUTPUT_EXCERPT_MAX_CHARS`. */
function excerpt(stdout: string, stderr: string): string {
  const combined = stdout + stderr;
  if (combined.length <= OUTPUT_EXCERPT_MAX_CHARS) return combined;
  return combined.slice(combined.length - OUTPUT_EXCERPT_MAX_CHARS);
}

/** Pipeline phase a check suite can be selected for. Mirrors `checks.usage` in `orchestrator.yaml`. */
export type CheckUsagePhase = "verify" | "integration" | "regression";

/** Shape of `orchestrator.yaml`'s `checks.usage` (see `config/schema.ts`). */
export interface CheckUsage {
  verify?: string;
  integration?: string;
  regression?: string;
}

/**
 * Resolves which suite name to run for a given pipeline `phase`, per the
 * configured `usage` mapping (e.g. `config.orchestrator.checks?.usage`),
 * falling back to `fallback` when `usage` has no entry for `phase`. Throws
 * if neither resolves — a caller invoking a phase must have a suite for it,
 * either from config or from an explicit fallback.
 */
export function resolveSuiteName(
  usage: CheckUsage | undefined,
  phase: CheckUsagePhase,
  fallback?: string
): string {
  const resolved = usage?.[phase] ?? fallback;
  if (resolved === undefined) {
    throw new Error(
      `No check suite configured for phase "${phase}" and no fallback was given`
    );
  }
  return resolved;
}
