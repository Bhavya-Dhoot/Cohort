/**
 * Stdio MCP server exposing the worker supervisor (`worker/`) to Claude Code
 * as the 8-tool surface documented in docs/ARCHITECTURE.md ("MCP tool
 * surface"). This module wires together config loading, the budget tracker,
 * a run-level event log, and `createWorkerSupervisor` — it owns no
 * lifecycle logic of its own; every tool handler is a thin adapter that
 * calls into those already-tested modules and shapes the result for an LLM
 * caller.
 *
 * Disk is still source of truth here (see ARCHITECTURE.md "State &
 * persistence"): `createAgenticMcpServer` never trusts in-memory state
 * across calls except where explicitly noted below, so two server instances
 * pointed at the same `projectDir` (e.g. across an MCP restart) converge on
 * the same run and the same worker registry.
 *
 * Three judgment calls made in this module, not spelled out verbatim by the
 * calling contract, documented here rather than silently picked:
 *
 * 1. **`worktreeBaseDir` excludes `runId`.** `worktreePathFor` (see
 *    `worktree/paths.ts`) already joins a hash of `runId` onto whatever base
 *    directory it's given, to keep worktree paths short (Windows MAX_PATH).
 *    Folding `runId` into `worktreeBaseDir` itself as well would nest it
 *    twice. This module passes the *parent* of that hashed segment
 *    (`<projectDir>/../<projectDirName>-agentic-worktrees`, unless
 *    `orchestrator.yaml`'s `worktree.baseDir` overrides it) so the final
 *    on-disk path matches ARCHITECTURE.md's documented layout exactly once.
 *
 * 2. **`spawn_worker`'s `baseBranch` is validated, not threaded through.**
 *    `WorkerSupervisor.spawn`'s options (`worker/types.ts`) have no per-call
 *    base-ref override — a supervisor pins one base ref for its whole run,
 *    resolved lazily from the repo's checked-out branch. Modifying that
 *    contract is out of this module's ownership. So `baseBranch`, when
 *    supplied, is checked against that same resolution (via the same `git
 *    rev-parse --abbrev-ref HEAD` the supervisor itself would run) and the
 *    call is refused with an explanatory `isError` if it disagrees, rather
 *    than silently ignored or silently honored.
 *
 * 3. **Budget reconciliation is delta-based.** `BudgetTracker.reconcile`
 *    (`budget/index.ts`) *adds* `actualUsd` to a worker's committed cost —
 *    it's designed for a single reconcile call per worker, not repeated
 *    polling. But `SessionUsage.costUsd` from OpenCode is a cumulative
 *    total, and `worker_status`/`collect_worker` can legitimately be polled
 *    many times while a worker runs. Reconciling the *delta* since the last
 *    known committed amount (read back from `budget.snapshot()`, so it's
 *    durable across MCP restarts too) keeps repeated polling idempotent
 *    instead of multiplying a worker's counted cost by its poll count.
 */

import { randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, resolveModelRoute, type OrchestratorConfig } from "../config/index.js";
import { readJsonIfExists } from "../lib/fs.js";
import { openEventLog, type EventLog } from "../events/index.js";
import { createBudgetTracker, type BudgetTracker } from "../budget/index.js";
import { createWorkerSupervisor, type WorkerMeta, type WorkerState, type WorkerSupervisor } from "../worker/index.js";
import { createOpencodeClient } from "../opencode-client/client.js";
import type { OpencodeClient, SessionUsage } from "../opencode-client/types.js";
import { runGit } from "../worktree/index.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateAgenticMcpServerDeps {
  client?: OpencodeClient;
  now?: () => number;
}

export interface CreateAgenticMcpServerOptions {
  /** The target project's repo root (contains/gains `.agentic-os/`). */
  projectDir: string;
  /** Directory holding the five shipped `*.yaml` defaults (`<repo>/config`). */
  platformConfigDir: string;
  deps?: CreateAgenticMcpServerDeps;
}

export interface AgenticMcpServer {
  server: McpServer;
  close(): Promise<void>;
}

/** Must be kept in sync with the `WorkerState` union in `worker/types.ts`. */
const WORKER_STATES = [
  "created",
  "worktree_provisioning",
  "worktree_ready",
  "session_starting",
  "running",
  "completed",
  "failed",
  "timeout",
  "aborted",
  "orphaned",
  "verifying",
  "verified",
  "verification_failed",
  "merged",
  "discarded"
] as const satisfies readonly WorkerState[];

interface CurrentRun {
  runId: string;
}

export async function createAgenticMcpServer(opts: CreateAgenticMcpServerOptions): Promise<AgenticMcpServer> {
  const projectDir = resolve(opts.projectDir);
  const now = opts.deps?.now ?? Date.now;
  const client = opts.deps?.client ?? createOpencodeClient();

  const stateRoot = join(projectDir, ".agentic-os");
  const overridesDir = join(stateRoot, "config");
  const config = await loadConfig(opts.platformConfigDir, (await directoryExists(overridesDir)) ? overridesDir : undefined);

  const runId = await resolveRunId(stateRoot, now);
  const runDir = join(stateRoot, "runs", runId);

  const projectDirName = basename(projectDir);
  const worktreeBaseDir =
    config.orchestrator.worktree.baseDir ?? join(projectDir, "..", `${projectDirName}-agentic-worktrees`);

  const supervisor = createWorkerSupervisor({
    client,
    stateDir: runDir,
    repoDir: projectDir,
    worktreeBaseDir,
    runId,
    defaults: {
      timeoutMs: config.orchestrator.worker.timeoutMinutes * 60_000,
      infraRetryMax: config.orchestrator.worker.infraRetryMax
    }
  });

  const budget = await createBudgetTracker({
    filePath: join(runDir, "cost.json"),
    softCapUsd: config.orchestrator.budget.softCapUsd,
    hardCapUsd: config.orchestrator.budget.hardCapUsd
  });

  const runEventLog = openEventLog(join(runDir, "events.jsonl"));

  const ctx: ServerCtx = { projectDir, runDir, config, supervisor, budget, runEventLog, cachedBaseRef: undefined };

  const server = new McpServer({ name: "agentic-os", version: "0.1.0" });
  registerTools(server, ctx);

  return {
    server,
    close: () => server.close()
  };
}

// ---------------------------------------------------------------------------
// Run bootstrap helpers
// ---------------------------------------------------------------------------

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function formatRunId(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `run-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Reads `<stateRoot>/current-run.json`, creating it if absent — see
 * ARCHITECTURE.md "State & persistence". Creation uses an exclusive
 * (`wx`) write rather than `atomicWriteJson`'s unconditional rename: two
 * processes racing this function on a fresh `projectDir` (no
 * `current-run.json` yet) would otherwise each generate their own `runId`
 * and each unconditionally overwrite the other's write, leaving the
 * "losing" process operating against a `runDir` that `current-run.json` no
 * longer references (split-brain run state). `wx` makes the create
 * itself mutually exclusive: on `EEXIST`, the loser re-reads the file and
 * converges on the winner's `runId` instead of keeping its own.
 */
async function resolveRunId(stateRoot: string, now: () => number): Promise<string> {
  const currentRunPath = join(stateRoot, "current-run.json");
  const existing = await readJsonIfExists<CurrentRun>(currentRunPath);
  if (existing) {
    return existing.runId;
  }
  const created: CurrentRun = { runId: formatRunId(now()) };
  await mkdir(stateRoot, { recursive: true });
  try {
    await writeFile(currentRunPath, JSON.stringify(created, null, 2), { encoding: "utf8", flag: "wx" });
    return created.runId;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process won the race; converge on its value instead of our own.
      const winner = await readJsonIfExists<CurrentRun>(currentRunPath);
      if (winner) {
        return winner.runId;
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared tool context + helpers
// ---------------------------------------------------------------------------

interface ServerCtx {
  projectDir: string;
  runDir: string;
  config: OrchestratorConfig;
  supervisor: WorkerSupervisor;
  budget: BudgetTracker;
  runEventLog: EventLog;
  /** Lazily resolved, memoized `git rev-parse --abbrev-ref HEAD` for `spawn_worker`'s `baseBranch` check. */
  cachedBaseRef: string | undefined;
}

/** A tool handler's outcome before it's wrapped into an MCP `CallToolResult`. */
interface ToolOutcome {
  isError?: boolean;
  /** Attached to the run-event log line and, on thrown errors, used to look up current worker state. */
  workerId?: string;
  payload: Record<string, unknown>;
}

/**
 * Every tool that accepts a caller-supplied `workerId` (everything except
 * `spawn_worker`, whose `workerId` is always server-generated via
 * `randomBytes`) enforces this at the zod schema layer, so an invalid value
 * never reaches a handler at all. This constant is also enforced again here,
 * directly at path construction, so any current or future call path through
 * `workerMetaPath`/`workerEventsPath` — including `runTool`'s own
 * catch-all, which looks up worker state by `workerId` on ANY thrown error —
 * can't build a path outside `<runDir>/workers/` even if it isn't reached
 * via a zod-validated tool input.
 */
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertValidWorkerId(workerId: string): void {
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new Error(`Invalid workerId '${workerId}': must match ${WORKER_ID_PATTERN.source}`);
  }
}

function workerMetaPath(ctx: ServerCtx, workerId: string): string {
  assertValidWorkerId(workerId);
  return join(ctx.runDir, "workers", workerId, "meta.json");
}

function workerEventsPath(ctx: ServerCtx, workerId: string): string {
  assertValidWorkerId(workerId);
  return join(ctx.runDir, "workers", workerId, "events.jsonl");
}

async function readWorkerMeta(ctx: ServerCtx, workerId: string): Promise<WorkerMeta | undefined> {
  return readJsonIfExists<WorkerMeta>(workerMetaPath(ctx, workerId));
}

function compactWorker(ctx: ServerCtx, meta: WorkerMeta, nowMs: number): Record<string, unknown> {
  return {
    workerId: meta.workerId,
    taskId: meta.taskId,
    state: meta.state,
    ageSeconds: Math.round((nowMs - meta.createdAt) / 1000),
    costUsd: meta.usage?.costUsd,
    lastError: meta.lastError
  };
}

function budgetSnapshotPublic(ctx: ServerCtx): { tier: string; committedUsd: number; reservedUsd: number } {
  const snapshot = ctx.budget.snapshot();
  return { tier: snapshot.tier, committedUsd: snapshot.committedUsd, reservedUsd: snapshot.reservedUsd };
}

/** See module doc point 3: reconciles only the *new* cost observed since the last reconcile for this worker. */
async function reconcileUsage(ctx: ServerCtx, workerId: string, usage: SessionUsage | undefined): Promise<void> {
  if (usage?.costUsd === undefined) {
    return;
  }
  const alreadyCommitted = ctx.budget.snapshot().perWorker[workerId]?.committedUsd ?? 0;
  const delta = usage.costUsd - alreadyCommitted;
  if (delta > 0) {
    await ctx.budget.reconcile(workerId, delta);
  }
}

/** See module doc point 2: resolves (once) the base ref a fresh `WorkerSupervisor` would resolve on its own. */
async function resolveDefaultBaseRef(ctx: ServerCtx): Promise<string> {
  if (ctx.cachedBaseRef === undefined) {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], ctx.projectDir);
    ctx.cachedBaseRef = stdout.trim();
  }
  return ctx.cachedBaseRef;
}

function textResult(payload: unknown, isError?: boolean): CallToolResult {
  return { isError, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * Runs one tool handler, turning its `ToolOutcome` (or a thrown error) into
 * an MCP `CallToolResult`, and appends exactly one line to the run-level
 * event log either way — this is the file the plugin's monitor tails.
 */
async function runTool(
  ctx: ServerCtx,
  name: string,
  workerIdHint: string | undefined,
  fn: () => Promise<ToolOutcome>
): Promise<CallToolResult> {
  try {
    const outcome = await fn();
    const workerId = outcome.workerId ?? workerIdHint;
    const summary =
      typeof outcome.payload.state === "string" ? String(outcome.payload.state) : JSON.stringify(outcome.payload).slice(0, 200);
    await ctx.runEventLog.append({ type: "tool", tool: name, workerId, ok: !outcome.isError, summary });
    return textResult(outcome.payload, outcome.isError);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const state = workerIdHint ? ((await readWorkerMeta(ctx, workerIdHint))?.state ?? "unknown") : "unknown";
    await ctx.runEventLog.append({ type: "tool", tool: name, workerId: workerIdHint, ok: false, summary: message });
    return textResult({ error: message, workerId: workerIdHint, state }, true);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTools(server: McpServer, ctx: ServerCtx): void {
  server.registerTool(
    "spawn_worker",
    {
      title: "Spawn Worker",
      description:
        "Provision a git worktree and start an OpenCode worker session to execute one task. Call this to begin " +
        "implementation/search work on a task card. Reserves budget before spawning and refuses (isError) if that " +
        "would exceed the run's hard cost cap — check the returned tier/committedUsd/reservedUsd if refused, and " +
        "do not retry blindly. Returns as soon as the session starts; the prompt turn continues in the background " +
        "— poll worker_status or stream_worker_log for progress.",
      inputSchema: {
        taskId: z.string().min(1).describe("Identifier of the task card this worker executes (used for tracking and branch naming)."),
        prompt: z.string().min(1).describe("The natural-language task prompt sent to the OpenCode worker session."),
        taskType: z
          .string()
          .optional()
          .describe("Task category used to resolve a model route from config.models.routing when `model` is omitted (e.g. 'implementation', 'search')."),
        model: z.string().optional().describe("Explicit 'provider/model' string; overrides taskType-based routing."),
        agentId: z.string().optional().describe("OpenCode agent id (e.g. 'build') the session should run as."),
        baseBranch: z
          .string()
          .optional()
          .describe(
            "Git ref the worker's worktree branches from. Optional — M1 pins one base branch for the whole run " +
              "(the repo's checked-out branch, resolved once); a value that disagrees with it is rejected. Omit unless " +
              "you need to explicitly confirm the run's base branch."
          )
      }
    },
    async (input) =>
      runTool(ctx, "spawn_worker", undefined, () => spawnWorkerHandler(ctx, input))
  );

  server.registerTool(
    "worker_status",
    {
      title: "Worker Status",
      description:
        "Poll one worker's current lifecycle state and cost usage, or omit workerId to poll every worker in this " +
        "run. Refreshes live usage from OpenCode and reconciles it into the run's budget as a side effect. Use this " +
        "to check whether a spawned worker is still running, completed, or failed, and to see the current budget " +
        "tier before deciding whether to spawn more workers.",
      inputSchema: {
        workerId: z
          .string()
          .regex(WORKER_ID_PATTERN, "workerId must match ^[A-Za-z0-9_-]{1,64}$")
          .optional()
          .describe("Worker to poll; omit to poll all workers in this run.")
      }
    },
    async (input) => runTool(ctx, "worker_status", input.workerId, () => workerStatusHandler(ctx, input))
  );

  server.registerTool(
    "list_workers",
    {
      title: "List Workers",
      description:
        "Enumerate workers in this run from the on-disk registry, optionally filtered by lifecycle state, without " +
        "any live status refresh (no OpenCode calls, no budget reconciliation). Cheaper than worker_status when you " +
        "just need an inventory, e.g. to find a workerId or count how many workers are currently running.",
      inputSchema: {
        state: z.enum(WORKER_STATES).optional().describe("Only return workers currently in this lifecycle state.")
      }
    },
    async (input) => runTool(ctx, "list_workers", undefined, () => listWorkersHandler(ctx, input))
  );

  server.registerTool(
    "stream_worker_log",
    {
      title: "Stream Worker Log",
      description:
        "Tail one worker's event log (state transitions, tool/message progress) starting after sinceSeq. Call " +
        "repeatedly with the returned nextSinceSeq to page through new events while a worker runs. Results are " +
        "capped at 200 events per call — check `truncated` and re-call with the new nextSinceSeq if more remain.",
      inputSchema: {
        workerId: z
          .string()
          .min(1)
          .regex(WORKER_ID_PATTERN, "workerId must match ^[A-Za-z0-9_-]{1,64}$")
          .describe("Worker whose event log to read."),
        sinceSeq: z.number().int().nonnegative().optional().describe("Only return events with seq greater than this (from a prior call's nextSinceSeq).")
      }
    },
    async (input) => runTool(ctx, "stream_worker_log", input.workerId, () => streamWorkerLogHandler(ctx, input))
  );

  server.registerTool(
    "abort_worker",
    {
      title: "Abort Worker",
      description:
        "Forcefully stop a worker that is still in-flight (any state from created through running), e.g. because " +
        "it's off-track or the run is out of budget. Always requires a reason, which is recorded to the run's audit " +
        "trail. Fails if the worker has already reached a terminal state.",
      inputSchema: {
        workerId: z
          .string()
          .min(1)
          .regex(WORKER_ID_PATTERN, "workerId must match ^[A-Za-z0-9_-]{1,64}$")
          .describe("Worker to abort."),
        reason: z.string().min(1).describe("Why this worker is being aborted; recorded for the audit trail.")
      }
    },
    async (input) => runTool(ctx, "abort_worker", input.workerId, () => abortWorkerHandler(ctx, input))
  );

  server.registerTool(
    "collect_worker",
    {
      title: "Collect Worker",
      description:
        "Pull a structured summary of a worker's produced diff (changed files, diffstat) plus its latest cost " +
        "usage, without changing its state. Call this after a worker completes to inspect what it did before " +
        "deciding whether to verify_worker it or abort/discard it.",
      inputSchema: {
        workerId: z
          .string()
          .min(1)
          .regex(WORKER_ID_PATTERN, "workerId must match ^[A-Za-z0-9_-]{1,64}$")
          .describe("Worker whose diff/usage to collect.")
      }
    },
    async (input) => runTool(ctx, "collect_worker", input.workerId, () => collectWorkerHandler(ctx, input))
  );

  server.registerTool(
    "verify_worker",
    {
      title: "Verify Worker",
      description:
        "Independently verify a completed worker's work by running a real shell command (build/test/lint) against " +
        "its actual worktree — never trust the worker's own self-reported completion. Required before " +
        "finalize_worker('merge'). Moves the worker to verified or verification_failed based on the real exit code.",
      inputSchema: {
        workerId: z
          .string()
          .min(1)
          .regex(WORKER_ID_PATTERN, "workerId must match ^[A-Za-z0-9_-]{1,64}$")
          .describe("Worker to verify; must be completed, verified, or verification_failed."),
        command: z.string().min(1).describe("Shell command to run in the worker's worktree, e.g. 'npm test'."),
        timeoutMs: z.number().int().positive().optional().describe("Kill the command if it runs longer than this. Default 300000 (5 min).")
      }
    },
    async (input) => runTool(ctx, "verify_worker", input.workerId, () => verifyWorkerHandler(ctx, input))
  );

  server.registerTool(
    "finalize_worker",
    {
      title: "Finalize Worker",
      description:
        "Merge a verified worker's branch into targetBranch (default: the run's base branch), or discard a " +
        "worker's worktree/branch entirely. On a merge conflict this still returns successfully with merged:false " +
        "and the conflicting file list — treat that as a decision point (e.g. discard and replan), not a tool error.",
      inputSchema: {
        workerId: z
          .string()
          .min(1)
          .regex(WORKER_ID_PATTERN, "workerId must match ^[A-Za-z0-9_-]{1,64}$")
          .describe("Worker to finalize."),
        action: z.enum(["merge", "discard"]).describe("'merge' requires the worker to be verified; 'discard' works from most terminal-ish states."),
        targetBranch: z.string().optional().describe("Branch to merge into; defaults to the run's base branch.")
      }
    },
    async (input) => runTool(ctx, "finalize_worker", input.workerId, () => finalizeWorkerHandler(ctx, input))
  );
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

interface SpawnWorkerInput {
  taskId: string;
  prompt: string;
  taskType?: string | undefined;
  model?: string | undefined;
  agentId?: string | undefined;
  baseBranch?: string | undefined;
}

async function spawnWorkerHandler(ctx: ServerCtx, input: SpawnWorkerInput): Promise<ToolOutcome> {
  if (input.baseBranch !== undefined) {
    const effectiveBaseRef = await resolveDefaultBaseRef(ctx);
    if (input.baseBranch !== effectiveBaseRef) {
      return {
        isError: true,
        payload: {
          error:
            `M1 pins one base branch per run ('${effectiveBaseRef}'); per-spawn baseBranch overrides are not ` +
            `supported. Omit baseBranch or pass '${effectiveBaseRef}'.`
        }
      };
    }
  }

  const model = input.model ?? resolveModelRoute(ctx.config, input.taskType);
  const workerId = randomBytes(4).toString("hex");

  const reserved = await ctx.budget.reserve(workerId);
  if (!reserved.allowed) {
    return {
      isError: true,
      workerId,
      payload: {
        error: "Budget refused: spawning this worker would exceed the run's hard cost cap.",
        tier: reserved.tier,
        committedUsd: reserved.committedUsd,
        reservedUsd: reserved.reservedUsd
      }
    };
  }

  const meta = await ctx.supervisor.spawn({
    taskId: input.taskId,
    prompt: input.prompt,
    model,
    agentId: input.agentId,
    workerId
  });

  if (meta.state === "failed") {
    // supervisor.spawn() never rejects on a bootstrap failure (ensureServer/
    // createWorktree/createSession) — it resolves with a 'failed' WorkerMeta
    // instead. Report that as an isError so the caller doesn't mistake it for
    // a started worker, and release the reservation since nothing was spent.
    await ctx.budget.reconcile(workerId, 0);
    return {
      isError: true,
      workerId: meta.workerId,
      payload: {
        error: meta.lastError?.message ?? "worker spawn failed",
        workerId: meta.workerId,
        state: meta.state,
        tier: ctx.budget.snapshot().tier
      }
    };
  }

  return {
    workerId: meta.workerId,
    payload: {
      workerId: meta.workerId,
      worktreePath: meta.worktreePath,
      branchName: meta.branchName,
      sessionId: meta.sessionId,
      state: meta.state,
      tier: reserved.tier
    }
  };
}

interface WorkerStatusInput {
  workerId?: string | undefined;
}

async function workerStatusHandler(ctx: ServerCtx, input: WorkerStatusInput): Promise<ToolOutcome> {
  const nowMs = Date.now();

  if (input.workerId) {
    const meta = await ctx.supervisor.status(input.workerId);
    await reconcileUsage(ctx, input.workerId, meta.usage);
    return {
      workerId: meta.workerId,
      payload: { worker: compactWorker(ctx, meta, nowMs), budget: budgetSnapshotPublic(ctx) }
    };
  }

  const metas = await ctx.supervisor.list();
  const workers: Record<string, unknown>[] = [];
  for (const stub of metas) {
    const meta = await ctx.supervisor.status(stub.workerId);
    await reconcileUsage(ctx, stub.workerId, meta.usage);
    workers.push(compactWorker(ctx, meta, nowMs));
  }
  return { payload: { workers, budget: budgetSnapshotPublic(ctx) } };
}

interface ListWorkersInput {
  state?: WorkerState | undefined;
}

async function listWorkersHandler(ctx: ServerCtx, input: ListWorkersInput): Promise<ToolOutcome> {
  const nowMs = Date.now();
  const metas = await ctx.supervisor.list();
  const filtered = input.state ? metas.filter((m) => m.state === input.state) : metas;
  return { payload: { workers: filtered.map((m) => compactWorker(ctx, m, nowMs)) } };
}

interface StreamWorkerLogInput {
  workerId: string;
  sinceSeq?: number | undefined;
}

const STREAM_LOG_CAP = 200;

async function streamWorkerLogHandler(ctx: ServerCtx, input: StreamWorkerLogInput): Promise<ToolOutcome> {
  const meta = await readWorkerMeta(ctx, input.workerId);
  if (!meta) {
    throw new Error(`Unknown worker '${input.workerId}'`);
  }

  const log = openEventLog(workerEventsPath(ctx, input.workerId));
  const all = await log.read(input.sinceSeq);
  const truncated = all.length > STREAM_LOG_CAP;
  const events = all.slice(0, STREAM_LOG_CAP);
  const nextSinceSeq = events.length > 0 ? events[events.length - 1]!.seq : (input.sinceSeq ?? 0);

  return {
    workerId: input.workerId,
    payload: { state: meta.state, events, nextSinceSeq, truncated }
  };
}

interface AbortWorkerInput {
  workerId: string;
  reason: string;
}

async function abortWorkerHandler(ctx: ServerCtx, input: AbortWorkerInput): Promise<ToolOutcome> {
  const meta = await ctx.supervisor.abort(input.workerId, input.reason);
  return { workerId: meta.workerId, payload: { workerId: meta.workerId, state: meta.state } };
}

interface CollectWorkerInput {
  workerId: string;
}

async function collectWorkerHandler(ctx: ServerCtx, input: CollectWorkerInput): Promise<ToolOutcome> {
  const collected = await ctx.supervisor.collect(input.workerId);
  const status = await ctx.supervisor.status(input.workerId);
  await reconcileUsage(ctx, input.workerId, status.usage);

  return {
    workerId: status.workerId,
    payload: {
      workerId: status.workerId,
      taskId: status.taskId,
      state: status.state,
      filesChanged: collected.filesChanged,
      diffstat: collected.diffstat,
      costUsd: status.usage?.costUsd,
      lastError: status.lastError
    }
  };
}

interface VerifyWorkerInput {
  workerId: string;
  command: string;
  timeoutMs?: number | undefined;
}

async function verifyWorkerHandler(ctx: ServerCtx, input: VerifyWorkerInput): Promise<ToolOutcome> {
  const meta = await ctx.supervisor.verify(input.workerId, input.command, input.timeoutMs);
  return {
    workerId: meta.workerId,
    payload: {
      workerId: meta.workerId,
      state: meta.state,
      passed: meta.verify?.passed,
      exitCode: meta.verify?.exitCode,
      timedOut: meta.verify?.timedOut
    }
  };
}

interface FinalizeWorkerInput {
  workerId: string;
  action: "merge" | "discard";
  targetBranch?: string | undefined;
}

async function finalizeWorkerHandler(ctx: ServerCtx, input: FinalizeWorkerInput): Promise<ToolOutcome> {
  const meta = await ctx.supervisor.finalize(input.workerId, input.action, input.targetBranch);
  return {
    workerId: meta.workerId,
    payload: {
      workerId: meta.workerId,
      state: meta.state,
      merged: meta.merge?.merged,
      mergeSha: meta.merge?.mergeSha,
      conflictFiles: meta.merge?.conflictFiles
    }
  };
}
