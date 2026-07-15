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
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, resolveModelRoute, type OrchestratorConfig } from "../config/index.js";
import { atomicWriteJson, readJsonIfExists } from "../lib/fs.js";
import { openEventLog, type EventLog } from "../events/index.js";
import { createBudgetTracker, type BudgetTracker } from "../budget/index.js";
import { createWorkerSupervisor, type WorkerMeta, type WorkerState, type WorkerSupervisor } from "../worker/index.js";
import { createOpencodeClient } from "../opencode-client/client.js";
import type { OpencodeClient, SessionUsage } from "../opencode-client/types.js";
import type { FetchFn } from "../opencode-client/http.js";
import {
  assertIsWorktreeRoot,
  ensureIntegrationBranch,
  mergeInDagOrder,
  removeWorktree,
  runGit,
  worktreePathFor
} from "../worktree/index.js";
import { resolveFreeModel, type ResolveFreeModelResult } from "../model-catalog/index.js";
import {
  TaskCardStore,
  PlanTaskInputSchema,
  selectBatch,
  validateDag,
  type PlanTaskInput,
  type TaskCard
} from "../tasks/index.js";
import { openMemoryStore, type MemoryStore } from "../memory/index.js";
import { resolveSuiteName, runCheckSuite, type CheckSuiteResult } from "../checks/index.js";
import {
  PlanSchema,
  validateOrgReferences,
  type Batch,
  type ReplanRecord,
  type Domain,
  type OrgChart
} from "../plan/index.js";
import {
  openReviewStore,
  ReviewFindingSchema,
  ReviewVerdictOutcomeSchema,
  type ReviewFinding,
  type ReviewVerdictOutcome,
  type ReviewStore
} from "../review/index.js";
import {
  generateSpecialist,
  retireSpecialist,
  listSpecialists,
  type SpecialistMode,
  type PermissionValue,
  type SpecialistSpec
} from "../specialist/index.js";

/**
 * Sentinel routing value (see `config/models.yaml`'s `routing.default`):
 * resolved lazily, once per MCP server instance, via `model-catalog/`
 * against the run's live `opencode serve` catalog rather than a hardcoded
 * model string. An explicit `spawn_worker` `model` param, or a `taskType`
 * route pointing at a real `provider/model` string, bypasses this entirely.
 */
const AUTO_FREE_MODEL = "auto:free";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateAgenticMcpServerDeps {
  client?: OpencodeClient;
  now?: () => number;
  /** Used only to resolve `auto:free` against the catalog; defaults to the global `fetch`. */
  fetchFn?: FetchFn;
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
  const fetchFn = opts.deps?.fetchFn ?? fetch;

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

  // M2 DAG-aware task board: one per run (lives under runDir, like
  // cost.json/events.jsonl), loaded once at startup so its in-memory map is
  // ready before any tool call.
  const taskStore = new TaskCardStore(join(runDir, "task-board.json"));
  await taskStore.load();

  // Cross-run shared project memory: deliberately NOT under runDir (a fresh
  // run must still see prior runs' mission/decision-log/etc).
  const memory = openMemoryStore(join(stateRoot, "memory"));

  // Reviewer verdict storage: like taskStore, scoped to this run
  // (<runDir>/reviews/) since a verdict is about work done within this run.
  const reviewStore = openReviewStore(runDir);

  const ctx: ServerCtx = {
    projectDir,
    runDir,
    runId,
    config,
    supervisor,
    budget,
    runEventLog,
    cachedBaseRef: undefined,
    client,
    fetchFn,
    cachedFreeModel: undefined,
    taskStore,
    memory,
    reviewStore,
    worktreeBaseDir,
    serialChains: new Map()
  };

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
  /** This server instance's run id (see `resolveRunId`) — needed for `integrationBranchName`/`worktreePathFor`. */
  runId: string;
  config: OrchestratorConfig;
  supervisor: WorkerSupervisor;
  budget: BudgetTracker;
  runEventLog: EventLog;
  /** Lazily resolved, memoized `git rev-parse --abbrev-ref HEAD` for `spawn_worker`'s `baseBranch` check. */
  cachedBaseRef: string | undefined;
  client: OpencodeClient;
  fetchFn: FetchFn;
  /**
   * Memoized `resolveFreeModel` result for `AUTO_FREE_MODEL`, scoped to this
   * server instance's lifetime — resolved at most once per MCP server start
   * (including a resolution failure, which stays cached too) so restarting
   * the MCP server is the way to pick up a changed catalog, per the calling
   * contract ("re-resolve per MCP server start").
   */
  cachedFreeModel: Promise<ResolveFreeModelResult> | undefined;
  /** M2 DAG-aware task board, bound to `<runDir>/task-board.json`; loaded once at server startup (see `createAgenticMcpServer`). */
  taskStore: TaskCardStore;
  /** Cross-run shared project memory, bound to `<projectDir>/.agentic-os/memory` — NOT under `runDir`. */
  memory: MemoryStore;
  /** Reviewer verdict storage, bound to `<runDir>/reviews/` — scoped to this run, like `taskStore`. */
  reviewStore: ReviewStore;
  /** Base directory worktrees (worker worktrees, and `integrate_batch`'s throwaway regression worktree) are provisioned under. */
  worktreeBaseDir: string;
  /**
   * Keyed per-process critical-section chains — see `runSerialized`. Used to
   * serialize `replan_record`'s iteration-counter read-then-write, artifact
   * index allocation (`checks/`/`replans/` `<n>.json` files), and every
   * operation that mutates `projectDir`'s shared git checkout
   * (`integrate_batch`'s merge sequence and `finalize_worker('merge')`),
   * mirroring the `ioChain` pattern already used by `budget/index.ts` and
   * `TaskCardStore`.
   */
  serialChains: Map<string, Promise<unknown>>;
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

/**
 * Path-safety pattern for M2 pipeline artifact ids (batchId, suiteName, the
 * scope label in a checks/ filename, ...) that get embedded directly into
 * on-disk filenames under `runDir`. Mirrors `WORKER_ID_PATTERN` above, with
 * `.` additionally allowed since suite names mirror config keys. Enforced
 * both at the zod schema layer (so a bad value never reaches a handler) and
 * again here at path construction, same rationale as `assertValidWorkerId`.
 */
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function assertArtifactId(label: string, value: string): void {
  if (!ARTIFACT_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} '${value}': must match ${ARTIFACT_ID_PATTERN.source}`);
  }
}

function batchPath(ctx: ServerCtx, batchId: string): string {
  assertArtifactId("batchId", batchId);
  return join(ctx.runDir, "batches", `${batchId}.json`);
}

function contractPath(ctx: ServerCtx, contractId: string): string {
  assertArtifactId("contractId", contractId);
  return join(ctx.runDir, "contracts", `${contractId}.json`);
}

function replansDir(ctx: ServerCtx): string {
  return join(ctx.runDir, "replans");
}

function checksDir(ctx: ServerCtx): string {
  return join(ctx.runDir, "checks");
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

/**
 * Runs `fn` strictly after every previously-queued call under the same
 * `key` on this `ServerCtx` has settled, serializing concurrent tool-call
 * handlers that would otherwise race a shared read-then-write critical
 * section within this process — same technique as `budget/index.ts`'s
 * `ioChain` and `TaskCardStore`'s persist chain, generalized to a keyed map
 * so unrelated critical sections (e.g. `replan_record`'s counter vs.
 * `integrate_batch`'s git checkout) don't serialize against each other.
 * This is an in-process mutex only — it does not protect against two
 * separate MCP server processes racing the same on-disk files.
 */
function runSerialized<T>(ctx: ServerCtx, key: string, fn: () => Promise<T>): Promise<T> {
  const prior = ctx.serialChains.get(key) ?? Promise.resolve();
  const task = prior.then(() => fn());
  // Keep the chain alive even if this call fails, so later calls under the
  // same key still run (each still observes its own failure via `task`).
  ctx.serialChains.set(
    key,
    task.then(
      () => undefined,
      () => undefined
    )
  );
  return task;
}

/** See module doc point 2: resolves (once) the base ref a fresh `WorkerSupervisor` would resolve on its own. */
async function resolveDefaultBaseRef(ctx: ServerCtx): Promise<string> {
  if (ctx.cachedBaseRef === undefined) {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], ctx.projectDir);
    const ref = stdout.trim();
    if (ref === "HEAD") {
      // `git rev-parse --abbrev-ref HEAD` prints the literal string "HEAD"
      // when projectDir is in detached-HEAD state — not a usable branch
      // name. Fail fast here (mirrors worker/index.ts's resolveBaseRef)
      // instead of silently caching "HEAD" and only discovering the problem
      // later when integrate_batch's switch-back calls `git switch -- HEAD`
      // and throws after merges/task-card updates already landed.
      throw new Error(
        "repository must be on a branch; detached HEAD unsupported (spawn_worker/integrate_batch)"
      );
    }
    ctx.cachedBaseRef = ref;
  }
  return ctx.cachedBaseRef;
}

/**
 * Resolves the `AUTO_FREE_MODEL` sentinel to a concrete `"provider/model"`
 * string, memoized on `ctx.cachedFreeModel` for this server instance's
 * lifetime (see that field's docstring). `ensureServer` is called with the
 * same `stateDir` (`ctx.runDir`) the `WorkerSupervisor` itself uses, so this
 * attaches to the same `opencode serve` a spawn would use rather than
 * starting a second one — `ensureServer` is idempotent by design (it reuses
 * a live server recorded in `server.json`), so calling it here and again
 * inside `supervisor.spawn` is safe.
 */
async function resolveAutoFreeModel(ctx: ServerCtx): Promise<ResolveFreeModelResult> {
  ctx.cachedFreeModel ??= (async () => {
    const handle = await ctx.client.ensureServer({ stateDir: ctx.runDir });
    return resolveFreeModel(handle.baseUrl, ctx.fetchFn);
  })();
  return ctx.cachedFreeModel;
}

/**
 * Finds the worker most recently spawned for `taskId`, by scanning the
 * run's worker registry for a `meta.taskId` match — the join key
 * `spawn_worker` already persists on every `WorkerMeta` — rather than
 * introducing a second place (e.g. a `TaskCard.workerId` field kept in
 * sync by hand) to duplicate that association. Multiple workers can share a
 * `taskId` across retries; the most recently created one wins.
 */
async function findWorkerForTask(ctx: ServerCtx, taskId: string): Promise<WorkerMeta | undefined> {
  const metas = await ctx.supervisor.list();
  const matches = metas.filter((m) => m.taskId === taskId);
  if (matches.length === 0) {
    return undefined;
  }
  return matches.reduce((latest, m) => (m.createdAt > latest.createdAt ? m : latest));
}

/**
 * Reverts `taskId`'s card from `assigned` back to `pending` (clearing the
 * `meta.batchId` stamp `markAssigned` set) if that's its current status —
 * called from every `spawn_worker` failure/refusal path so a task
 * `next_batch` marked `assigned` doesn't get stranded forever when the
 * worker it was assigned to never actually starts: `selectBatch` only ever
 * re-offers `pending` cards, and nothing else in this module transitions a
 * card off `assigned` on a failure path. No-op if the card is missing or
 * already in some other status.
 */
async function releaseTaskAssignment(ctx: ServerCtx, taskId: string): Promise<void> {
  const card = ctx.taskStore.get(taskId);
  if (card && card.status === "assigned") {
    const meta = { ...card.meta };
    delete meta.batchId;
    await ctx.taskStore.put({ ...card, status: "pending", meta });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Next 1-based index for `<prefix>-<n>.json` files already present in
 * `dir` (1 if `dir` doesn't exist yet), so repeated `run_check_suite`/
 * `integrate_batch` calls against the same scope+suite don't clobber each
 * other's persisted `CheckSuiteResult`.
 */
async function nextArtifactIndex(dir: string, prefix: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 1;
  }
  const re = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.json$`);
  let max = 0;
  for (const entry of entries) {
    const m = re.exec(entry);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

/**
 * Allocates the next `<prefix>-<n>.json` index in `dir` and writes `data`
 * to it, with the allocate-and-write pair serialized (per `dir`+`prefix`,
 * via `runSerialized`) against every other call sharing that same key —
 * `nextArtifactIndex`'s readdir-then-max is otherwise a TOCTOU: two
 * concurrent callers (e.g. two `integrate_batch` calls resolving the same
 * configured regression suite, or two `run_check_suite` calls with the same
 * scope+suite) can compute the same `n` and race their renames onto the
 * identical destination path (observed to throw `EPERM` on Windows rather
 * than safely no-op-overwriting).
 */
async function writeNextArtifact(ctx: ServerCtx, dir: string, prefix: string, data: unknown): Promise<string> {
  return runSerialized(ctx, `artifact:${dir}::${prefix}`, async () => {
    const idx = await nextArtifactIndex(dir, prefix);
    const path = join(dir, `${prefix}-${idx}.json`);
    await atomicWriteJson(path, data);
    return path;
  });
}

/**
 * Best-effort topological order of `cards` by `dependsOn`, restricted to ids
 * present in `cards` itself — a dependency on a task outside the batch is
 * assumed already `done` (`selectBatch` wouldn't have offered this task
 * otherwise) and isn't an ordering constraint here. Cycles can't happen for
 * a batch `selectBatch` actually produced (`plan_submit`'s `validateDag`
 * already rejected any cyclic plan before it was ever persisted), so the
 * leftover-append fallback below is defensive only.
 */
function topoSortBatch(cards: TaskCard[]): string[] {
  const ids = new Set(cards.map((c) => c.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const card of cards) {
    inDegree.set(card.id, 0);
    dependents.set(card.id, []);
  }
  for (const card of cards) {
    for (const dep of card.dependsOn) {
      if (!ids.has(dep)) continue;
      dependents.get(dep)!.push(card.id);
      inDegree.set(card.id, (inDegree.get(card.id) ?? 0) + 1);
    }
  }

  const order: string[] = [];
  const ready = cards
    .filter((c) => inDegree.get(c.id) === 0)
    .map((c) => c.id)
    .sort();
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  for (const card of [...cards].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!order.includes(card.id)) {
      order.push(card.id);
    }
  }
  return order;
}

/**
 * Adds a worktree checked out onto an EXISTING branch (`git worktree add`
 * without `-b`) — `createWorktree` (worktree/create.ts) always creates a
 * NEW branch via `-b`, which fails outright against a branch that already
 * exists (the integration branch, by the time `integrate_batch` calls this).
 * Mirrors `createWorktree`'s longpaths/mkdir setup so the same Windows
 * MAX_PATH mitigation applies here too.
 */
async function addExistingBranchWorktree(repoDir: string, worktreePath: string, branchName: string): Promise<void> {
  await runGit(["config", "core.longpaths", "true"], repoDir);
  await mkdir(dirname(worktreePath), { recursive: true });
  await runGit(["worktree", "add", "--", worktreePath, branchName], repoDir);
}

/** In-flight (non-terminal) worker lifecycle states — see `WORKER_STATES` above. */
const IN_FLIGHT_WORKER_STATES: ReadonlySet<WorkerState> = new Set([
  "created",
  "worktree_provisioning",
  "worktree_ready",
  "session_starting",
  "running",
  "verifying"
]);

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

  // -------------------------------------------------------------------------
  // M2 multi-worker pipeline tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "plan_submit",
    {
      title: "Plan Submit",
      description:
        "Validate and persist a DAG-aware task plan for this run: an objective, a set of task cards " +
        "(id/dependsOn/fileOwnership/...), and optional contracts between them. Runs cycle and dangling-dependency " +
        "detection before persisting anything — a plan that fails validation returns isError with the offending " +
        "cycles/danglingDeps and writes nothing. On success, persists plan.json, one contracts/<id>.json per " +
        "contract, seeds the task board with every task as 'pending', and snapshots the task graph into shared " +
        "memory. Call this once per run before next_batch.",
      inputSchema: PlanSchema.shape
    },
    async (input) => runTool(ctx, "plan_submit", undefined, () => planSubmitHandler(ctx, input))
  );

  server.registerTool(
    "next_batch",
    {
      title: "Next Batch",
      description:
        "Select the next batch of DAG-ready, file-ownership-disjoint pending tasks (up to maxWorkers, default " +
        "config.orchestrator.worker.maxConcurrent) and mark them 'assigned'. Refuses to select anything (empty " +
        "tasks, reason 'budget hard cap') when the run's budget tier is already 'hard' — check the returned budget " +
        "field before retrying. On a non-empty selection, persists a batches/<batchId>.json record. Spawn one " +
        "worker per returned task yourself (spawn_worker's taskId: card.id) — this tool does not spawn workers.",
      inputSchema: {
        maxWorkers: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap on tasks selected this call; defaults to config.orchestrator.worker.maxConcurrent.")
      }
    },
    async (input) => runTool(ctx, "next_batch", undefined, () => nextBatchHandler(ctx, input))
  );

  server.registerTool(
    "batch_status",
    {
      title: "Batch Status",
      description:
        "Read-only snapshot of a batch's tasks: each task's card status plus (if a worker has been spawned for it) " +
        "that worker's id and lifecycle state. No side effects — safe to poll repeatedly while workers run.",
      inputSchema: {
        batchId: z
          .string()
          .min(1)
          .regex(ARTIFACT_ID_PATTERN, `batchId must match ${ARTIFACT_ID_PATTERN.source}`)
          .describe("Batch to inspect, from next_batch's response.")
      }
    },
    async (input) => runTool(ctx, "batch_status", undefined, () => batchStatusHandler(ctx, input))
  );

  server.registerTool(
    "integrate_batch",
    {
      title: "Integrate Batch",
      description:
        "Merges every batch task whose worker has reached 'verified' into this run's shared integration branch " +
        "(agentic/integration/<runId>, created from the run's base branch on first use), in DAG order. Tasks whose " +
        "worker isn't verified yet are skipped and returned separately as notVerified, rather than failing the " +
        "call. NOTE on projectDir's checkout: merging runs directly against projectDir (the same mechanism " +
        "finalize_worker uses), which switches projectDir's checked-out branch as a side effect — this tool " +
        "switches it back to the run's base branch once merging finishes, before doing anything else, so the only " +
        "observable disturbance is transient. If regressionSuite is given (or config.orchestrator.checks.usage." +
        "regression is configured), runs it in a throwaway worktree of the integration branch — never against " +
        "projectDir directly — and removes that worktree afterward regardless of outcome. Successfully merged " +
        "tasks' cards move to 'done'; a conflicting merge's task moves to 'failed' and integration stops there " +
        "(remaining tasks are reported, not attempted). Persists checks/integration-<suite>-<n>.json when a " +
        "regression suite ran, and updates the batch's status to 'integrated' or 'failed'.",
      inputSchema: {
        batchId: z
          .string()
          .min(1)
          .regex(ARTIFACT_ID_PATTERN, `batchId must match ${ARTIFACT_ID_PATTERN.source}`)
          .describe("Batch to integrate."),
        regressionSuite: z
          .string()
          .regex(ARTIFACT_ID_PATTERN, `regressionSuite must match ${ARTIFACT_ID_PATTERN.source}`)
          .optional()
          .describe(
            "Check suite name to run against the integration branch; defaults to " +
              "config.orchestrator.checks.usage.regression if configured, else no regression check runs."
          )
      }
    },
    async (input) => runTool(ctx, "integrate_batch", undefined, () => integrateBatchHandler(ctx, input))
  );

  server.registerTool(
    "run_check_suite",
    {
      title: "Run Check Suite",
      description:
        "Runs a named multi-command check suite (config.orchestrator.checks.suites) against one worker's worktree " +
        "(workerId), an explicit path inside projectDir (path), or projectDir itself (omit both — mutually " +
        "exclusive with each other). Persists checks/<scope>-<suiteName>-<n>.json and returns the full " +
        "CheckSuiteResult (pass/fail per command with output excerpts) — this is the only source of truth for " +
        "whether checks passed, independent of any worker's self-report.",
      inputSchema: {
        workerId: z
          .string()
          .regex(WORKER_ID_PATTERN, "workerId must match ^[A-Za-z0-9_-]{1,64}$")
          .optional()
          .describe("Run inside this worker's worktree. Mutually exclusive with path."),
        path: z
          .string()
          .optional()
          .describe("Run inside this path, resolved relative to projectDir; must stay inside projectDir. Mutually exclusive with workerId."),
        suiteName: z
          .string()
          .min(1)
          .regex(ARTIFACT_ID_PATTERN, `suiteName must match ${ARTIFACT_ID_PATTERN.source}`)
          .describe("Key into config.orchestrator.checks.suites.")
      }
    },
    async (input) => runTool(ctx, "run_check_suite", input.workerId, () => runCheckSuiteHandler(ctx, input))
  );

  server.registerTool(
    "memory",
    {
      title: "Memory",
      description:
        "Read, write, append to, or bundle sections of this project's shared cross-run memory " +
        "(<projectDir>/.agentic-os/memory). 'read' returns one section's raw content (null if never written). " +
        "'write' overwrites a snapshot section (mission/architecture/standards/progress/future-work/contracts/" +
        "task-graph) — rejected for append-only sections. 'append' adds a stamped JSON entry to an append-only " +
        "section (decision-log/known-bugs) — rejected for snapshot sections. 'bundle' concatenates multiple " +
        "sections as labeled markdown, truncating by fixed priority to stay within maxTokens (defaults to " +
        "config.memory.maxContextTokensPerHandoff) — check the returned truncated/omitted fields before assuming " +
        "full context made it through.",
      inputSchema: {
        action: z.enum(["read", "write", "append", "bundle"]).describe("Which memory operation to perform."),
        section: z.string().optional().describe("Section name; required for read/write/append."),
        content: z.string().optional().describe("New section content; required for write."),
        entry: z.record(z.string(), z.unknown()).optional().describe("Entry object to append; required for append."),
        sections: z.array(z.string()).optional().describe("Section names to include; required for bundle."),
        maxTokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Token cap for bundle; defaults to config.memory.maxContextTokensPerHandoff.")
      }
    },
    async (input) => runTool(ctx, "memory", undefined, () => memoryHandler(ctx, input))
  );

  server.registerTool(
    "replan_record",
    {
      title: "Replan Record",
      description:
        "Records a replan iteration (reason, affected task ids, optionally new task cards seeded as 'pending') " +
        "against this run's replans/<iteration>.json log, and appends a decision-log memory entry. Enforces " +
        "config.orchestrator.replan.maxIterations: a call that would exceed the cap returns escalate:true with " +
        "capRemaining:0 and records nothing — treat that as a hard stop requiring a human, not something to retry.",
      inputSchema: {
        reason: z.string().min(1).describe("Why this replan is happening."),
        affectedTaskIds: z.array(z.string()).min(1).describe("Task ids this replan affects."),
        newTasks: z
          .array(PlanTaskInputSchema)
          .optional()
          .describe("New task cards to seed as 'pending', if this replan adds work.")
      }
    },
    async (input) => runTool(ctx, "replan_record", undefined, () => replanRecordHandler(ctx, input))
  );

  // -------------------------------------------------------------------------
  // Review + specialist tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "review_verdict",
    {
      title: "Review Verdict",
      description:
        "Record or read a reviewer subagent's structured verdict on a task. Reviewer subagents are read-only " +
        "(Read/Grep/Glob only) — recording here is the ONLY way their judgment reaches the orchestrator, so call " +
        "'record' after every review pass. A 'revise' or 'block' verdict must cite at least one concrete finding " +
        "(severity/file/line/note) — a non-pass verdict with zero findings is rejected as isError (anti-rubber-" +
        "stamp; enforced no matter which reviewer produced it). 'get' returns every stored verdict for a task plus " +
        "the blocking roll-up in one call: summary.blocking is true, and summary.worst is 'block' or 'revise', when " +
        "any reviewer's LATEST verdict hasn't cleared — treat that as do-not-integrate, not something to route " +
        "around.",
      inputSchema: {
        action: z.enum(["record", "get"]).describe("'record' persists a verdict; 'get' reads back verdicts plus the blocking roll-up."),
        taskId: z.string().min(1).describe("Task card id this verdict is about."),
        reviewerId: z
          .string()
          .optional()
          .describe("Reviewer identity, e.g. 'security', 'architecture'. Required for 'record'; an optional filter for 'get'."),
        verdict: ReviewVerdictOutcomeSchema.optional().describe("Required for 'record': 'pass' | 'revise' | 'block'."),
        findings: z
          .array(ReviewFindingSchema)
          .optional()
          .describe("Concrete issues backing the verdict (severity/file/line/note). Required (non-empty) when verdict is 'revise' or 'block'."),
        summary: z.string().optional().describe("Optional free-text summary of the review.")
      }
    },
    async (input) => runTool(ctx, "review_verdict", undefined, () => reviewVerdictHandler(ctx, input))
  );

  server.registerTool(
    "specialist",
    {
      title: "Specialist",
      description:
        "Generate, retire, or list OpenCode specialist agents (<projectDir>/.opencode/agent/<id>.md). Generate one " +
        "only when a task genuinely needs a distinct expert persona/system-prompt beyond the standard build agent, " +
        "and retire it once that work is done — this is a budget, not a default: config.agents." +
        "max_concurrent_specialists caps how many can exist at once, and 'generate' refuses (isError) at the cap. " +
        "config.agents.default_permission.deny is always merged into every generated agent's permission map as a " +
        "safety floor and cannot be relaxed away by the spec's own 'permission' field.",
      inputSchema: {
        action: z.enum(["generate", "retire", "list"]).describe("Which specialist operation to perform."),
        agentId: z
          .string()
          .optional()
          .describe("Path-safe specialist id (lowercase letters/digits/hyphens); also the filename stem. Required for 'generate'/'retire'."),
        role: z.string().optional().describe("Human-readable role label, e.g. 'OAuth Engineer'. Required for 'generate'."),
        description: z
          .string()
          .optional()
          .describe("Shown to OpenCode's agent selector to decide when to route to this specialist. Required for 'generate'."),
        systemPrompt: z
          .string()
          .optional()
          .describe("The specialist's system prompt; becomes the generated agent file's markdown body. Required for 'generate'."),
        mode: z.enum(["subagent", "primary", "all"]).optional().describe("OpenCode agent mode; defaults to 'subagent'."),
        model: z.string().optional().describe("Explicit 'provider/model' string; omit to inherit the caller's model."),
        temperature: z.number().optional().describe("Sampling temperature override."),
        steps: z.number().int().positive().optional().describe("Max agent steps override."),
        permission: z
          .record(z.string(), z.enum(["allow", "ask", "deny"]))
          .optional()
          .describe(
            "Command-glob -> allow|ask|deny overrides. config.agents.default_permission.deny is always merged in " +
              "afterward as a floor, regardless of what's set here."
          )
      }
    },
    async (input) => runTool(ctx, "specialist", undefined, () => specialistHandler(ctx, input))
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

/**
 * Resolves `config.models.downgrade_on_soft_cap` to a concrete model value
 * for `spawnWorkerHandler`'s soft-cap auto-downgrade. `downgrade_on_soft_cap`
 * (`config/schema.ts`'s `ModelsFileSchema`) is a KEY into `models.yaml`
 * (e.g. "small_model"), not the model value itself -- `ModelsFile`'s shape
 * only names `routing`/`downgrade_on_soft_cap`/`small_model` explicitly
 * rather than as an open record, so this indexes it dynamically and returns
 * `undefined` for an absent key or one that doesn't resolve to a string
 * (misconfiguration), rather than throwing and failing the whole spawn over
 * a downgrade that was never mandatory. If that resolved value is itself
 * `AUTO_FREE_MODEL`, it flows into the same auto:free resolution below as
 * any other model would -- the downgrade only needs to pick a route, not a
 * concrete provider/model string.
 */
function resolveDowngradeModel(config: OrchestratorConfig): string | undefined {
  const key = config.models.downgrade_on_soft_cap;
  if (!key) {
    return undefined;
  }
  const value = (config.models as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

async function spawnWorkerHandler(ctx: ServerCtx, input: SpawnWorkerInput): Promise<ToolOutcome> {
  if (input.baseBranch !== undefined) {
    const effectiveBaseRef = await resolveDefaultBaseRef(ctx);
    if (input.baseBranch !== effectiveBaseRef) {
      await releaseTaskAssignment(ctx, input.taskId);
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

  let model = input.model ?? resolveModelRoute(ctx.config, input.taskType);

  // Budget soft-cap auto-downgrade (config.models.downgrade_on_soft_cap): once
  // the run is over softCapUsd (but not yet hard-capped -- reserve() below
  // refuses that case outright), swap in the configured cheaper model instead
  // of the normal taskType/default route, UNLESS the caller pinned an
  // explicit `model` themselves (an explicit choice stays authoritative even
  // under budget pressure). Checked here, before reserve()/spawn(), against
  // the PRE-spawn tier -- this reservation hasn't happened yet, so
  // ctx.budget.tier() reflects the run's state as of the last completed
  // spawn/reconcile, which is exactly "was the run already over budget before
  // this call" per the calling contract.
  if (input.model === undefined && ctx.budget.tier() === "soft") {
    const downgradeModel = resolveDowngradeModel(ctx.config);
    if (downgradeModel !== undefined) {
      await ctx.runEventLog.append({
        type: "model_downgraded",
        from: model,
        to: downgradeModel,
        reason: "soft_cap"
      });
      model = downgradeModel;
    }
  }

  if (model === AUTO_FREE_MODEL) {
    let resolved: ResolveFreeModelResult;
    try {
      resolved = await resolveAutoFreeModel(ctx);
    } catch (err) {
      await releaseTaskAssignment(ctx, input.taskId);
      return {
        isError: true,
        payload: {
          error: `Resolving '${AUTO_FREE_MODEL}' failed: ${err instanceof Error ? err.message : String(err)}`
        }
      };
    }
    model = resolved.model;
    await ctx.runEventLog.append({ type: "model_resolved", model, reason: AUTO_FREE_MODEL });
  }

  const workerId = randomBytes(4).toString("hex");

  const reserved = await ctx.budget.reserve(workerId);
  if (!reserved.allowed) {
    // Budget refused, so no worker was (or ever will be) created for this
    // taskId on this attempt — a task next_batch marked 'assigned' must not
    // be left stranded there forever (it would never be re-selected by a
    // later next_batch, and would keep blocking file-ownership-overlapping
    // siblings as "active"). See releaseTaskAssignment.
    await releaseTaskAssignment(ctx, input.taskId);
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
    await releaseTaskAssignment(ctx, input.taskId);
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
  // 'merge' switches/merges directly against the shared projectDir checkout
  // (same mechanism integrate_batch's merge sequence uses) — serialize it
  // through the same "repo-mutation" chain integrateBatchHandler uses so the
  // two can't interleave their git operations against one working tree.
  // 'discard' only removes a worktree/branch and never touches projectDir's
  // checkout, so it doesn't need to serialize against either.
  const meta =
    input.action === "merge"
      ? await runSerialized(ctx, "repo-mutation", () =>
          ctx.supervisor.finalize(input.workerId, input.action, input.targetBranch)
        )
      : await ctx.supervisor.finalize(input.workerId, input.action, input.targetBranch);
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

// ---------------------------------------------------------------------------
// M2 multi-worker pipeline tool handlers
// ---------------------------------------------------------------------------

interface PlanSubmitInput {
  objective: string;
  tasks: PlanTaskInput[];
  contracts?: { id: string; name: string; description: string; interface?: string; producerTaskId?: string; consumerTaskIds?: string[] }[] | undefined;
  domains?: Domain[] | undefined;
  orgChart?: OrgChart | undefined;
}

async function planSubmitHandler(ctx: ServerCtx, input: PlanSubmitInput): Promise<ToolOutcome> {
  const now = Date.now();
  const cards: TaskCard[] = input.tasks.map(
    (task): TaskCard => ({
      ...task,
      status: "pending",
      createdAt: now,
      updatedAt: now
    })
  );

  const dag = validateDag(cards);
  if (!dag.valid) {
    return {
      isError: true,
      payload: { valid: false, taskCount: cards.length, cycles: dag.cycles, danglingDeps: dag.danglingDeps }
    };
  }

  // Org-consistency gate: every org node / task `domain` must reference an
  // id actually declared in `domains`. Must run (and fail closed) before any
  // persistence below -- otherwise an inconsistent orgChart silently becomes
  // the run's persisted planning artifact (see validateOrgReferences' doc
  // comment in plan/schema.ts).
  const orgRefs = validateOrgReferences({
    objective: input.objective,
    tasks: input.tasks,
    contracts: input.contracts,
    domains: input.domains,
    orgChart: input.orgChart
  });
  if (!orgRefs.valid) {
    return {
      isError: true,
      payload: { valid: false, taskCount: cards.length, issues: orgRefs.issues }
    };
  }

  const planId = randomBytes(4).toString("hex");
  await atomicWriteJson(join(ctx.runDir, "plan.json"), {
    planId,
    objective: input.objective,
    tasks: input.tasks,
    contracts: input.contracts ?? [],
    domains: input.domains,
    orgChart: input.orgChart,
    createdAt: now
  });

  for (const contract of input.contracts ?? []) {
    await atomicWriteJson(contractPath(ctx, contract.id), contract);
  }

  await ctx.taskStore.putMany(cards);

  await ctx.memory.writeSection(
    "task-graph",
    JSON.stringify({
      planId,
      tasks: cards.map((c) => ({ id: c.id, dependsOn: c.dependsOn, fileOwnership: c.fileOwnership, status: c.status }))
    })
  );

  return { payload: { planId, taskCount: cards.length, valid: true, cycles: [], danglingDeps: [] } };
}

interface NextBatchInput {
  maxWorkers?: number | undefined;
}

async function nextBatchHandler(ctx: ServerCtx, input: NextBatchInput): Promise<ToolOutcome> {
  const budget = budgetSnapshotPublic(ctx);
  if (budget.tier === "hard") {
    return {
      payload: { batchId: null, tasks: [], blocked: [], reason: "budget hard cap", budget }
    };
  }

  const maxConcurrent = input.maxWorkers ?? ctx.config.orchestrator.worker.maxConcurrent;
  const cards = ctx.taskStore.list();
  const selection = selectBatch(cards, { maxConcurrent });

  if (selection.ready.length === 0) {
    return { payload: { batchId: null, tasks: [], blocked: selection.blocked } };
  }

  const batchId = randomBytes(4).toString("hex");
  const readyIds = selection.ready.map((c) => c.id);
  await ctx.taskStore.markAssigned(readyIds, batchId);
  // Re-read post-assignment so the returned cards reflect their real
  // persisted status ('assigned'), not the pre-assignment snapshot selectBatch saw.
  const assignedCards = readyIds
    .map((id) => ctx.taskStore.get(id))
    .filter((c): c is TaskCard => c !== undefined);

  const batch: Batch = { batchId, taskIds: readyIds, createdAt: Date.now(), status: "selected" };
  await atomicWriteJson(batchPath(ctx, batchId), batch);

  return { payload: { batchId, tasks: assignedCards, blocked: selection.blocked } };
}

interface BatchStatusInput {
  batchId: string;
}

async function batchStatusHandler(ctx: ServerCtx, input: BatchStatusInput): Promise<ToolOutcome> {
  const batch = await readJsonIfExists<Batch>(batchPath(ctx, input.batchId));
  if (!batch) {
    throw new Error(`Unknown batch '${input.batchId}'`);
  }

  const tasks: Record<string, unknown>[] = [];
  let allTerminal = true;
  for (const taskId of batch.taskIds) {
    const card = ctx.taskStore.get(taskId);
    const worker = await findWorkerForTask(ctx, taskId);
    if (worker && IN_FLIGHT_WORKER_STATES.has(worker.state)) {
      allTerminal = false;
    }
    tasks.push({
      taskId,
      workerId: worker?.workerId,
      taskState: card?.status ?? "unknown",
      workerState: worker?.state
    });
  }

  return {
    payload: {
      batchId: batch.batchId,
      status: batch.status,
      tasks,
      allTerminal,
      integrationBranch: batch.integrationBranch
    }
  };
}

/**
 * Commits whatever a verified worker's worktree left uncommitted, so
 * integrate_batch merges the worker's actual file changes instead of an
 * empty diff. `verify_worker` only checks that the worker's filesystem
 * state satisfies the verification command — it says nothing about whether
 * the worker ever ran `git commit` — so without this a worker that created
 * files but never committed passes verification yet merges nothing, and
 * integrate_batch reports success over an empty diff.
 *
 * This is a deliberate small duplicate of finalize_worker's merge-path
 * auto-commit (see `worker/index.ts`'s `finalizeWorker`, action "merge",
 * around its `assertIsWorktreeRoot` + `git status --porcelain` + `git add
 * -A`/`git commit` sequence) so both paths that merge a verified worker's
 * branch behave identically. worker/index.ts is out of this module's
 * ownership, so the pattern is copied here rather than shared.
 *
 * If the worktree no longer exists on disk (e.g. already cleaned up
 * out-of-band), there is nothing to commit — the worker's branch already
 * holds whatever was committed before removal — so this is skipped rather
 * than treated as an error.
 */
async function commitDirtyWorktreeForMerge(worktreePath: string, workerId: string): Promise<void> {
  try {
    await assertIsWorktreeRoot(worktreePath);
  } catch {
    return;
  }
  const dirty = await runGit(["status", "--porcelain"], worktreePath);
  if (dirty.stdout.trim().length > 0) {
    await runGit(["add", "-A"], worktreePath);
    await runGit(["commit", "-m", `agentic worker ${workerId}`], worktreePath);
  }
}

interface IntegrateBatchInput {
  batchId: string;
  regressionSuite?: string | undefined;
}

async function integrateBatchHandler(ctx: ServerCtx, input: IntegrateBatchInput): Promise<ToolOutcome> {
  // Every operation that mutates the shared projectDir git checkout
  // (this merge sequence, and finalize_worker('merge')) is serialized
  // through the same "repo-mutation" chain, so re-entrant/concurrent
  // integrate_batch calls (for the same or different batches) and
  // finalize_worker('merge') calls can never interleave their `git
  // switch`/`git merge` sequences against the one working tree. The
  // idempotency check just inside re-reads batch.json AFTER acquiring this
  // slot, so a second call queued up behind an in-flight one observes the
  // first call's terminal status rather than a stale pre-lock snapshot.
  return runSerialized(ctx, "repo-mutation", () => doIntegrateBatch(ctx, input));
}

async function doIntegrateBatch(ctx: ServerCtx, input: IntegrateBatchInput): Promise<ToolOutcome> {
  const batch = await readJsonIfExists<Batch>(batchPath(ctx, input.batchId));
  if (!batch) {
    throw new Error(`Unknown batch '${input.batchId}'`);
  }

  const cards = batch.taskIds.map((id) => ctx.taskStore.get(id)).filter((c): c is TaskCard => c !== undefined);
  const order = topoSortBatch(cards);

  const workersByTask = new Map<string, WorkerMeta>();
  for (const taskId of batch.taskIds) {
    const worker = await findWorkerForTask(ctx, taskId);
    if (worker) {
      workersByTask.set(taskId, worker);
    }
  }

  const merges: { taskId: string; sourceBranch: string }[] = [];
  const notVerified: string[] = [];
  for (const taskId of order) {
    const worker = workersByTask.get(taskId);
    if (worker && worker.state === "verified" && worker.branchName) {
      merges.push({ taskId, sourceBranch: worker.branchName });
    } else {
      notVerified.push(taskId);
    }
  }

  // Idempotent: a batch that already fully integrated has nothing left to
  // merge (re-running mergeInDagOrder against branches already merged into
  // the integration branch would be redundant at best). Return its
  // persisted state (plus a freshly-computed notVerified, which is a cheap
  // read with no git mutation) instead of re-doing any git work. A 'failed'
  // batch is deliberately NOT short-circuited here — conflicting/skipped
  // tasks are documented as retryable via a later integrate_batch call.
  if (batch.status === "integrated") {
    return {
      payload: {
        integrationBranch: batch.integrationBranch,
        merges: [],
        notVerified,
        regressionCheck: null,
        note: "Batch already integrated; returning existing state without re-merging.",
        allMerged: true,
        allPassed: true
      }
    };
  }

  // Nothing verified to merge: don't touch projectDir's checkout or
  // provision the integration branch/any worktree at all — there is
  // nothing for git to do. Report this plainly (not a vacuous
  // allMerged/allPassed:true over an empty merge set) and leave the batch
  // in a terminal-but-not-successful state rather than erroring.
  if (merges.length === 0) {
    await atomicWriteJson(batchPath(ctx, batch.batchId), { ...batch, status: "failed" });
    return {
      payload: {
        integrationBranch: batch.integrationBranch,
        merges: [],
        notVerified,
        regressionCheck: null,
        note: "No verified workers to merge for this batch — nothing to integrate.",
        allMerged: false,
        allPassed: false
      }
    };
  }

  // Resolve (and validate) the regression suite name BEFORE merging
  // anything or writing status 'integrating': an unknown/misconfigured
  // suite must fail fast, before any git state or task-card status
  // changes, rather than throwing after merges + card updates are already
  // durably persisted (which used to strand batch.json at 'integrating'
  // forever with no integrationBranch recorded).
  let suiteName = input.regressionSuite;
  if (!suiteName) {
    try {
      suiteName = resolveSuiteName(ctx.config.orchestrator.checks?.usage, "regression");
    } catch {
      suiteName = undefined;
    }
  }
  const suites = ctx.config.orchestrator.checks?.suites ?? {};
  if (suiteName && suites[suiteName] === undefined) {
    const available = Object.keys(suites).sort().join(", ") || "(none configured)";
    return {
      isError: true,
      payload: { error: `Unknown check suite "${suiteName}". Available suites: ${available}` }
    };
  }

  // Also fail fast (before 'integrating'/any merge) on a detached-HEAD
  // projectDir — see resolveDefaultBaseRef's guard.
  const baseRef = await resolveDefaultBaseRef(ctx);

  // A worker reaching 'verified' only proves its worktree passed
  // verify_worker's check command — not that it ever committed. Commit each
  // merging worker's outstanding changes now (mirroring finalize_worker's
  // merge-path auto-commit — see commitDirtyWorktreeForMerge above) so the
  // merge below captures real work instead of silently integrating an empty
  // diff. Runs before any git/state mutation here, same fail-fast placement
  // as the suite-validation guard above.
  for (const { taskId } of merges) {
    const worker = workersByTask.get(taskId);
    if (worker?.worktreePath) {
      await commitDirtyWorktreeForMerge(worker.worktreePath, worker.workerId);
    }
  }

  await atomicWriteJson(batchPath(ctx, batch.batchId), { ...batch, status: "integrating" });

  const { branchName: integrationBranch } = await ensureIntegrationBranch({
    repoDir: ctx.projectDir,
    runId: ctx.runId,
    baseRef
  });

  const mergeResult = await mergeInDagOrder({
    repoDir: ctx.projectDir,
    integrationBranch,
    merges
  });

  // mergeBranch (see worktree/merge.ts) `git switch`es projectDir onto
  // integrationBranch as part of attempting the FIRST merge, and leaves it
  // there — whether that merge (or a later one) ends up conflicting or not.
  // Switch back to the run's base branch now, before anything else touches
  // projectDir: this both restores the caller's checkout and frees
  // integrationBranch to be checked out in the throwaway regression
  // worktree below (git refuses to have the same branch checked out in two
  // worktrees at once). merges.length > 0 is guaranteed here (the
  // zero-merge case already returned above), so this always runs.
  await runGit(["switch", "--", baseRef], ctx.projectDir);

  for (const outcome of mergeResult.results) {
    const card = ctx.taskStore.get(outcome.taskId);
    if (!card) continue;
    if (outcome.outcome === "merged") {
      await ctx.taskStore.put({ ...card, status: "done" });
    } else if (outcome.outcome === "conflict") {
      await ctx.taskStore.put({
        ...card,
        status: "failed",
        meta: { ...card.meta, mergeConflictFiles: outcome.conflictFiles }
      });
    }
    // 'skipped' merge outcomes (tasks after a conflict) are left untouched —
    // never attempted, so still retryable in a later integrate_batch call.
  }

  let regressionCheck: CheckSuiteResult | null = null;
  let regressionNote: string | undefined;
  if (suiteName) {
    // suiteName was already validated against `suites` above, so this
    // shouldn't throw for a config-mismatch reason — but the throwaway
    // worktree must still always be cleaned up regardless of outcome.
    const tempWorktreePath = worktreePathFor(ctx.worktreeBaseDir, ctx.runId, `integ-${batch.batchId}`);
    try {
      await addExistingBranchWorktree(ctx.projectDir, tempWorktreePath, integrationBranch);
      regressionCheck = await runCheckSuite({ cwd: tempWorktreePath, suiteName, suites });
      await writeNextArtifact(ctx, checksDir(ctx), `integration-${suiteName}`, regressionCheck);
    } finally {
      await removeWorktree({ repoDir: ctx.projectDir, worktreePath: tempWorktreePath, force: true });
    }
  } else {
    regressionNote =
      "No regressionSuite given and none configured at config.orchestrator.checks.usage.regression — merges only, no checks ran.";
  }

  const allMerged = mergeResult.allMerged;
  const allPassed = allMerged && (regressionCheck ? regressionCheck.passed : true);
  const finalStatus: Batch["status"] = allPassed ? "integrated" : "failed";
  await atomicWriteJson(batchPath(ctx, batch.batchId), { ...batch, status: finalStatus, integrationBranch });

  return {
    payload: {
      integrationBranch,
      merges: mergeResult.results,
      notVerified,
      regressionCheck,
      ...(regressionNote ? { note: regressionNote } : {}),
      allMerged,
      allPassed
    }
  };
}

interface RunCheckSuiteInput {
  workerId?: string | undefined;
  path?: string | undefined;
  suiteName: string;
}

async function runCheckSuiteHandler(ctx: ServerCtx, input: RunCheckSuiteInput): Promise<ToolOutcome> {
  if (input.workerId && input.path) {
    return { isError: true, payload: { error: "Provide at most one of workerId or path, not both." } };
  }

  let cwd: string;
  let scope: string;
  if (input.workerId) {
    const meta = await readWorkerMeta(ctx, input.workerId);
    if (!meta?.worktreePath) {
      throw new Error(`Worker '${input.workerId}' has no worktree to run checks in`);
    }
    await assertIsWorktreeRoot(meta.worktreePath);
    cwd = meta.worktreePath;
    scope = input.workerId;
  } else if (input.path) {
    const resolvedPath = resolve(ctx.projectDir, input.path);
    const rel = relative(ctx.projectDir, resolvedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path '${input.path}' escapes projectDir`);
    }
    cwd = resolvedPath;
    scope = "path";
  } else {
    cwd = ctx.projectDir;
    scope = "project";
  }

  const result = await runCheckSuite({
    cwd,
    suiteName: input.suiteName,
    suites: ctx.config.orchestrator.checks?.suites ?? {}
  });

  await writeNextArtifact(ctx, checksDir(ctx), `${scope}-${input.suiteName}`, result);

  return { workerId: input.workerId, payload: { ...result } };
}

interface MemoryInput {
  action: "read" | "write" | "append" | "bundle";
  section?: string | undefined;
  content?: string | undefined;
  entry?: Record<string, unknown> | undefined;
  sections?: string[] | undefined;
  maxTokens?: number | undefined;
}

async function memoryHandler(ctx: ServerCtx, input: MemoryInput): Promise<ToolOutcome> {
  switch (input.action) {
    case "read": {
      if (!input.section) {
        throw new Error("'section' is required for action 'read'");
      }
      const content = await ctx.memory.readSection(input.section);
      return { payload: { section: input.section, content: content ?? null, exists: content !== undefined } };
    }
    case "write": {
      if (!input.section || input.content === undefined) {
        throw new Error("'section' and 'content' are required for action 'write'");
      }
      await ctx.memory.writeSection(input.section, input.content);
      return { payload: { section: input.section, ok: true } };
    }
    case "append": {
      if (!input.section || !input.entry) {
        throw new Error("'section' and 'entry' are required for action 'append'");
      }
      await ctx.memory.appendEntry(input.section, input.entry);
      return { payload: { section: input.section, ok: true } };
    }
    case "bundle": {
      if (!input.sections || input.sections.length === 0) {
        throw new Error("'sections' (non-empty) is required for action 'bundle'");
      }
      const maxTokens = input.maxTokens ?? ctx.config.memory.maxContextTokensPerHandoff;
      const bundle = await ctx.memory.buildContextBundle({ sections: input.sections, maxTokens });
      return { payload: { ...bundle } };
    }
  }
}

interface ReplanRecordInput {
  reason: string;
  affectedTaskIds: string[];
  newTasks?: PlanTaskInput[] | undefined;
}

async function replanRecordHandler(ctx: ServerCtx, input: ReplanRecordInput): Promise<ToolOutcome> {
  // The iteration counter (readdir replansDir, take max, +1) is a
  // read-then-write critical section shared by every replan_record call in
  // this process — serialize it through the "repo"-independent "replan"
  // chain so two overlapping calls can't both observe the same currentMax,
  // both pass the maxIterations cap check, and race their writes onto the
  // same replans/<n>.json (previously a TOCTOU that could silently let the
  // run exceed maxIterations — see runSerialized).
  return runSerialized(ctx, "replan", async () => {
    const dir = replansDir(ctx);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      entries = [];
    }
    const iterations = entries
      .map((f) => /^(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    const currentMax = iterations.length > 0 ? Math.max(...iterations) : 0;
    const nextIteration = currentMax + 1;
    const maxIterations = ctx.config.orchestrator.replan.maxIterations;

    if (nextIteration > maxIterations) {
      return { payload: { escalate: true, iteration: nextIteration, capRemaining: 0 } };
    }

    const now = Date.now();
    const newCards: TaskCard[] = (input.newTasks ?? []).map(
      (task): TaskCard => ({
        ...task,
        status: "pending",
        createdAt: now,
        updatedAt: now
      })
    );

    // Reject a replan that would introduce a cycle or a dangling dependency
    // BEFORE persisting anything — mirrors plan_submit's validateDag gate.
    // Validated against the full board (existing cards + this replan's new
    // ones) so a newTasks entry can correctly reference an already-persisted
    // older task.
    if (newCards.length > 0) {
      const dag = validateDag([...ctx.taskStore.list(), ...newCards]);
      if (!dag.valid) {
        return {
          isError: true,
          payload: { valid: false, cycles: dag.cycles, danglingDeps: dag.danglingDeps }
        };
      }
    }

    const record: ReplanRecord = {
      iteration: nextIteration,
      reason: input.reason,
      affectedTaskIds: input.affectedTaskIds,
      newTaskIds: newCards.map((c) => c.id),
      at: now
    };
    // Write the replan record BEFORE applying its new task cards. If the
    // process is killed between these two awaits, the surviving state is
    // "iteration N is durably recorded but its cards weren't added" (safe:
    // under-provisioned, and the cap accounting stays correct) rather than
    // the reverse ("new pending cards are live/schedulable but no replan
    // record exists for them", which would let the run silently exceed
    // maxIterations worth of task-seeding).
    await atomicWriteJson(join(dir, `${nextIteration}.json`), record);

    if (newCards.length > 0) {
      await ctx.taskStore.putMany(newCards);
    }

    await ctx.memory.appendEntry("decision-log", {
      type: "replan",
      iteration: nextIteration,
      reason: input.reason,
      affectedTaskIds: input.affectedTaskIds,
      newTaskIds: record.newTaskIds
    });

    return {
      payload: {
        iteration: nextIteration,
        capRemaining: maxIterations - nextIteration,
        escalate: false,
        newTaskIds: record.newTaskIds
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Review + specialist tool handlers
// ---------------------------------------------------------------------------

interface ReviewVerdictToolInput {
  action: "record" | "get";
  taskId: string;
  reviewerId?: string | undefined;
  verdict?: ReviewVerdictOutcome | undefined;
  findings?: ReviewFinding[] | undefined;
  summary?: string | undefined;
}

async function reviewVerdictHandler(ctx: ServerCtx, input: ReviewVerdictToolInput): Promise<ToolOutcome> {
  if (input.action === "record") {
    if (!input.reviewerId || !input.verdict) {
      throw new Error("'reviewerId' and 'verdict' are required for action 'record'");
    }
    // ReviewVerdictInputSchema (review/schema.ts) rejects a non-'pass'
    // verdict with zero findings, and its taskId/reviewerId fields reject
    // path-unsafe ids -- recordVerdict throws a formatted Error in either
    // case. Neither is caught here: it bubbles to runTool's catch-all (see
    // above), which is what turns every handler's thrown error into a clean
    // isError CallToolResult rather than a protocol-level failure.
    const result = await ctx.reviewStore.recordVerdict({
      taskId: input.taskId,
      reviewerId: input.reviewerId,
      verdict: input.verdict,
      findings: input.findings ?? [],
      summary: input.summary,
      at: Date.now()
    });
    return {
      payload: { taskId: result.taskId, reviewerId: result.reviewerId, verdict: input.verdict, path: result.path }
    };
  }

  // action === "get" -- getVerdicts/summarizeTask each assert taskId/
  // reviewerId path-safety themselves (review/index.ts); an invalid id
  // throws and bubbles to runTool's catch-all the same way as 'record' above.
  const [verdicts, summary] = await Promise.all([
    ctx.reviewStore.getVerdicts(input.taskId, input.reviewerId),
    ctx.reviewStore.summarizeTask(input.taskId)
  ]);
  return { payload: { verdicts, summary } };
}

interface SpecialistToolInput {
  action: "generate" | "retire" | "list";
  agentId?: string | undefined;
  role?: string | undefined;
  description?: string | undefined;
  systemPrompt?: string | undefined;
  mode?: SpecialistMode | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  steps?: number | undefined;
  permission?: Record<string, PermissionValue> | undefined;
}

async function specialistHandler(ctx: ServerCtx, input: SpecialistToolInput): Promise<ToolOutcome> {
  switch (input.action) {
    case "generate": {
      if (!input.agentId || !input.role || !input.description || !input.systemPrompt) {
        throw new Error("'agentId', 'role', 'description', and 'systemPrompt' are required for action 'generate'");
      }
      // Narrowed locals: TS's guard-narrowing above doesn't survive into the
      // nested runSerialized closure below (a re-read of `input.agentId` etc.
      // there would widen back to `string | undefined`).
      const agentId = input.agentId;
      const role = input.role;
      const description = input.description;
      const systemPrompt = input.systemPrompt;

      // Budget, not a default: refuse to create another specialist once
      // max_concurrent_specialists are already live, rather than letting the
      // roster grow unbounded. generateSpecialist itself still validates
      // agentId's path-safety (specialist/index.ts's assertValidAgentId) --
      // that error path is left to bubble to runTool's catch-all below,
      // same as review_verdict above.
      //
      // The cap check (list) and the write (generateSpecialist) are a
      // read-then-write critical section over an aggregate count across all
      // specialists, so -- like every other cap/counter in this file --
      // they're serialized under a single global key: two concurrent
      // 'generate' calls must not both observe a stale `existing.length`
      // and both pass the cap check.
      return runSerialized(ctx, "specialist-generate", async () => {
        const cap = ctx.config.agents.max_concurrent_specialists;
        const existing = await listSpecialists(ctx.projectDir);
        if (existing.length >= cap) {
          return {
            isError: true,
            payload: {
              error:
                `Refusing to generate specialist '${agentId}': config.agents.max_concurrent_specialists ` +
                `(${cap}) already reached (${existing.length} active). Retire one first.`
            }
          };
        }

        const spec: SpecialistSpec = {
          agentId,
          role,
          description,
          systemPrompt,
          mode: input.mode,
          model: input.model,
          temperature: input.temperature,
          steps: input.steps,
          permission: input.permission
        };
        const result = await generateSpecialist({
          projectDir: ctx.projectDir,
          spec,
          denyFloor: ctx.config.agents.default_permission.deny
        });
        return { payload: { agentId: result.agentId, path: result.path } };
      });
    }
    case "retire": {
      if (!input.agentId) {
        throw new Error("'agentId' is required for action 'retire'");
      }
      const result = await retireSpecialist({ projectDir: ctx.projectDir, agentId: input.agentId });
      return { payload: { removed: result.removed } };
    }
    case "list": {
      const specialists = await listSpecialists(ctx.projectDir);
      return { payload: { specialists } };
    }
  }
}
