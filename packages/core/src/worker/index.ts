/**
 * Worker state machine: owns an OpenCode worker's full lifecycle
 * (spawn -> run -> verify -> merge/discard) on top of injectable
 * dependencies (`OpencodeClient`, `worktree/`, `verify/`, `events/`).
 * See docs/ARCHITECTURE.md "Worker lifecycle" and "State & persistence".
 *
 * Disk is source of truth: every state change is persisted to
 * `<stateDir>/workers/<workerId>/meta.json` via `atomicWriteJson` before
 * it's considered real, and mirrored as an event in that worker's
 * `events.jsonl`. `reconcile()` and `status()`'s lazy post-restart check
 * are what let a crashed/restarted process rebuild truth from disk rather
 * than trusting in-memory state (there is none across restarts).
 *
 * Infra vs. logic classification (ARCHITECTURE.md "Infra vs. logic failure
 * classification"): every failure encountered while standing a worker up
 * (`ensureServer`, `createWorktree`, `createSession`) is infra by
 * construction — it's a process/HTTP-layer signal, not a judgment about the
 * work — and is auto-retried with backoff via `withInfraRetry`. Once a
 * worker is `running`, a transport-level prompt failure is still infra (the
 * `OpencodeClient` contract says so explicitly), but a timeout is logic
 * (ARCHITECTURE.md's own example of a logic failure is "turn budget
 * exhausted", which is exactly what a timeout is). `verify/` is the only
 * source of truth for post-hoc logic failures.
 *
 * Two judgment calls not spelled out by the caller's spec, documented here
 * rather than silently picked:
 *   - `ensureServer` runs during the `created` state, just before the
 *     `worktree_provisioning` transition — the five persisted pipeline
 *     states have no dedicated slot for "start the shared OpenCode server",
 *     so it's folded into the same infra-retry framework as a pre-step.
 *   - A manual `abort()` is recorded with classification `infra` (an
 *     operator decision to interrupt, not a correctness judgment — it isn't
 *     "logic" in ARCHITECTURE.md's sense of counting against replan budget).
 *
 * `finalize("merge")`'s default target branch is `baseRef`. Since
 * `createWorktree`'s own default `baseRef` is the literal string `"HEAD"`
 * (not usable as a `git switch` target), `resolveBaseRef` resolves the
 * repo's actual current branch name up front when the caller doesn't
 * configure one, and that resolved name is what's persisted as
 * `meta.baseRef` — so it's always a real branch usable later as a merge
 * target.
 */

import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, readJsonIfExists } from "../lib/fs.js";
import { openEventLog, type EventLog } from "../events/index.js";
import { runVerification, type VerifyResult } from "../verify/index.js";
import {
  assertIsWorktreeRoot,
  createWorktree,
  mergeBranch,
  removeWorktree,
  runGit,
  worktreePathFor
} from "../worktree/index.js";
import type { NormalizedEvent, OpencodeClient, PromptResult } from "../opencode-client/types.js";
import type {
  CollectResult,
  SpawnOptions,
  WorkerMeta,
  WorkerState,
  WorkerSupervisor,
  WorkerSupervisorDeps
} from "./types.js";

export type {
  CollectResult,
  FailureClassification,
  SpawnOptions,
  WorkerMeta,
  WorkerState,
  WorkerSupervisor,
  WorkerSupervisorDefaults,
  WorkerSupervisorDeps
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INFRA_RETRY_MAX = 3;
const DEFAULT_INFRA_BACKOFF_MS = [2000, 8000, 30000];

const ABORTABLE_STATES: readonly WorkerState[] = [
  "created",
  "worktree_provisioning",
  "worktree_ready",
  "session_starting",
  "running"
];
const VERIFIABLE_STATES: readonly WorkerState[] = ["completed", "verification_failed", "verified"];
const DISCARDABLE_STATES: readonly WorkerState[] = [
  "failed",
  "timeout",
  "verification_failed",
  "aborted",
  "orphaned",
  "verified"
];
const CRASHED_MID_SPAWN_STATES: readonly WorkerState[] = [
  "created",
  "worktree_provisioning",
  "worktree_ready",
  "session_starting"
];

interface InFlightPrompt {
  controller: AbortController;
  promise: Promise<void>;
}

interface Ctx {
  client: OpencodeClient;
  stateDir: string;
  repoDir: string;
  worktreeBaseDir: string;
  runId: string;
  timeoutMs: number;
  infraRetryMax: number;
  infraBackoffMs: number[];
  baseRef: string | undefined;
  inFlight: Map<string, InFlightPrompt>;
  eventLogs: Map<string, EventLog>;
  /** Serializes all `meta.json` reads+writes per worker (see `withWorkerIo`). */
  ioChains: Map<string, Promise<unknown>>;
}

export function createWorkerSupervisor(deps: WorkerSupervisorDeps): WorkerSupervisor {
  const ctx: Ctx = {
    client: deps.client,
    stateDir: deps.stateDir,
    repoDir: deps.repoDir,
    worktreeBaseDir: deps.worktreeBaseDir,
    runId: deps.runId,
    timeoutMs: deps.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    infraRetryMax: deps.defaults?.infraRetryMax ?? DEFAULT_INFRA_RETRY_MAX,
    infraBackoffMs: deps.defaults?.infraBackoffMs ?? DEFAULT_INFRA_BACKOFF_MS,
    baseRef: deps.defaults?.baseRef,
    inFlight: new Map(),
    eventLogs: new Map(),
    ioChains: new Map()
  };

  return {
    spawn: (opts) => spawnWorker(ctx, opts),
    status: (workerId) => statusWorker(ctx, workerId),
    list: () => listWorkers(ctx),
    abort: (workerId, reason) => abortWorker(ctx, workerId, reason),
    collect: (workerId) => collectWorker(ctx, workerId),
    verify: (workerId, command, timeoutMs) => verifyWorker(ctx, workerId, command, timeoutMs),
    finalize: (workerId, action, targetBranch) => finalizeWorker(ctx, workerId, action, targetBranch),
    reconcile: () => reconcileWorkers(ctx)
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function workerDir(ctx: Ctx, workerId: string): string {
  return join(ctx.stateDir, "workers", workerId);
}

function metaPath(ctx: Ctx, workerId: string): string {
  return join(workerDir(ctx, workerId), "meta.json");
}

function eventsPath(ctx: Ctx, workerId: string): string {
  return join(workerDir(ctx, workerId), "events.jsonl");
}

function getEventLog(ctx: Ctx, workerId: string): EventLog {
  let log = ctx.eventLogs.get(workerId);
  if (!log) {
    log = openEventLog(eventsPath(ctx, workerId));
    ctx.eventLogs.set(workerId, log);
  }
  return log;
}

async function logEvent(ctx: Ctx, workerId: string, event: { type: string; [key: string]: unknown }): Promise<void> {
  await getEventLog(ctx, workerId).append(event);
}

/**
 * Runs `fn` (a single read or write against a worker's `meta.json`)
 * serialized after every prior I/O op queued for that same worker, via
 * `ctx.ioChains`. Multiple independent call paths touch the same worker
 * concurrently in normal operation (a `status()` poll, the background
 * prompt lifecycle's timeout/completion handler, ...); on Windows, a
 * `rename` (the last step of `atomicWriteJson`) can fail with EPERM if
 * another handle — even just a concurrent `readFile` — has the destination
 * open at that instant. Serializing every read *and* write per worker
 * within this process avoids that entirely, since Node's single-threaded
 * event loop then guarantees no two fs operations against the same
 * `meta.json` are ever in flight at once.
 */
function withWorkerIo<T>(ctx: Ctx, workerId: string, fn: () => Promise<T>): Promise<T> {
  const prior = ctx.ioChains.get(workerId) ?? Promise.resolve();
  const result = prior.catch(() => undefined).then(fn);
  ctx.ioChains.set(workerId, result.catch(() => undefined));
  return result;
}

async function persist(ctx: Ctx, meta: WorkerMeta): Promise<void> {
  await withWorkerIo(ctx, meta.workerId, () => atomicWriteJson(metaPath(ctx, meta.workerId), meta));
}

async function loadMeta(ctx: Ctx, workerId: string): Promise<WorkerMeta> {
  return withWorkerIo(ctx, workerId, async () => {
    const meta = await readJsonIfExists<WorkerMeta>(metaPath(ctx, workerId));
    if (!meta) {
      throw new Error(`Unknown worker '${workerId}'`);
    }
    return meta;
  });
}

/**
 * Non-throwing variant used only by the background prompt-lifecycle
 * handlers (`onPromptSettled`/`onPromptRejected`/`onTimeout`). Those run
 * asynchronously, detached from any caller that could catch a rejection, so
 * a worker whose on-disk state has disappeared out from under them (e.g. its
 * run directory was cleaned up) must be a silent no-op rather than an
 * unhandled rejection.
 */
async function loadMetaIfExists(ctx: Ctx, workerId: string): Promise<WorkerMeta | undefined> {
  return withWorkerIo(ctx, workerId, () => readJsonIfExists<WorkerMeta>(metaPath(ctx, workerId)));
}

async function listWorkerIds(ctx: Ctx): Promise<string[]> {
  try {
    return await readdir(join(ctx.stateDir, "workers"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertState(meta: WorkerMeta, allowed: readonly WorkerState[], action: string): void {
  if (!allowed.includes(meta.state)) {
    throw new Error(
      `Cannot ${action} worker '${meta.workerId}': illegal from state '${meta.state}' ` +
        `(expected one of: ${allowed.join(", ")})`
    );
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Resolves `ensureServer`/`createWorktree`/`createSession` failures as infra, retrying with backoff. */
async function withInfraRetry<T>(ctx: Ctx, meta: WorkerMeta, step: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      meta.attempts.infra += 1;
      meta.lastError = { message: `${step}: ${errMessage(err)}`, classification: "infra" };
      meta.updatedAt = Date.now();
      await persist(ctx, meta);
      if (meta.attempts.infra > ctx.infraRetryMax) {
        throw err;
      }
      const idx = Math.min(meta.attempts.infra - 1, ctx.infraBackoffMs.length - 1);
      const delayMs = ctx.infraBackoffMs[idx] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}

/** See module doc: resolves the merge target default when the caller didn't configure one. */
async function resolveBaseRef(ctx: Ctx): Promise<string> {
  if (ctx.baseRef) {
    return ctx.baseRef;
  }
  const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], ctx.repoDir);
  const ref = stdout.trim();
  if (ref === "HEAD") {
    // `git rev-parse --abbrev-ref HEAD` prints the literal string "HEAD"
    // when repoDir is in detached-HEAD state — not a usable branch name.
    // Fail fast here (before any worktree is created) instead of silently
    // persisting "HEAD" as meta.baseRef and only discovering the problem
    // when finalize("merge") later calls `git switch HEAD` and throws.
    throw new Error(
      "repository must be on a branch; detached HEAD unsupported in M1"
    );
  }
  return ref;
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

async function spawnWorker(ctx: Ctx, opts: SpawnOptions): Promise<WorkerMeta> {
  const workerId = opts.workerId ?? randomBytes(4).toString("hex");
  const now = Date.now();
  const meta: WorkerMeta = {
    workerId,
    runId: ctx.runId,
    taskId: opts.taskId,
    state: "created",
    prompt: opts.prompt,
    model: opts.model,
    agentId: opts.agentId,
    createdAt: now,
    updatedAt: now,
    attempts: { infra: 0 }
  };
  await persist(ctx, meta);
  await logEvent(ctx, workerId, { type: "state", from: undefined, to: "created" });

  try {
    const handle = await withInfraRetry(ctx, meta, "ensureServer", () =>
      ctx.client.ensureServer({ stateDir: ctx.stateDir })
    );
    meta.baseUrl = handle.baseUrl;

    meta.state = "worktree_provisioning";
    meta.updatedAt = Date.now();
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", from: "created", to: "worktree_provisioning" });

    const baseRef = await resolveBaseRef(ctx);
    const worktreePath = worktreePathFor(ctx.worktreeBaseDir, ctx.runId, workerId);
    const branchName = `agentic/${ctx.runId.slice(0, 8)}/${workerId.slice(0, 8)}`;

    const info = await withInfraRetry(ctx, meta, "createWorktree", () =>
      createWorktree({ repoDir: ctx.repoDir, worktreePath, branchName, baseRef })
    );
    meta.worktreePath = info.worktreePath;
    meta.branchName = info.branchName;
    meta.baseRef = info.baseRef;

    meta.state = "worktree_ready";
    meta.updatedAt = Date.now();
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", from: "worktree_provisioning", to: "worktree_ready" });

    meta.state = "session_starting";
    meta.updatedAt = Date.now();
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", from: "worktree_ready", to: "session_starting" });

    const session = await withInfraRetry(ctx, meta, "createSession", () =>
      ctx.client.createSession(meta.baseUrl!, {
        directory: meta.worktreePath!,
        agent: opts.agentId,
        model: opts.model,
        title: opts.taskId
      })
    );
    meta.sessionId = session.id;

    meta.state = "running";
    meta.timeoutAt = Date.now() + ctx.timeoutMs;
    meta.updatedAt = Date.now();
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", from: "session_starting", to: "running" });

    // Fire-and-forget: the prompt turn is tracked in-process (ctx.inFlight)
    // and transitions completed/failed/timeout asynchronously; spawn()
    // itself returns as soon as the turn has started, per contract.
    startPromptLifecycle(ctx, meta);

    return meta;
  } catch (err) {
    // Worktree (if any was created) is left intact on failure for
    // debuggability, per ARCHITECTURE.md.
    meta.state = "failed";
    meta.lastError = { message: errMessage(err), classification: "infra" };
    meta.updatedAt = Date.now();
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", to: "failed", reason: meta.lastError.message });
    return meta;
  }
}

// ---------------------------------------------------------------------------
// Async prompt lifecycle (running -> completed | failed | timeout | aborted)
// ---------------------------------------------------------------------------

function startPromptLifecycle(ctx: Ctx, meta: WorkerMeta): void {
  const workerId = meta.workerId;
  const controller = new AbortController();
  let forced = false;

  const timer = setTimeout(() => {
    forced = true;
    void onTimeout(ctx, workerId, controller);
  }, ctx.timeoutMs);

  const promise = ctx.client
    .prompt(meta.baseUrl!, meta.sessionId!, meta.prompt, {
      signal: controller.signal,
      onEvent: (evt: NormalizedEvent) => {
        void logEvent(ctx, workerId, {
          type: "client_event",
          kind: evt.kind,
          summary: evt.summary,
          clientTs: evt.ts,
          raw: evt.raw
        });
      }
    })
    .then(async (result) => {
      clearTimeout(timer);
      if (forced) return;
      await onPromptSettled(ctx, workerId, result);
    })
    .catch(async (err) => {
      clearTimeout(timer);
      if (forced) return;
      await onPromptRejected(ctx, workerId, err);
    })
    .finally(() => {
      const entry = ctx.inFlight.get(workerId);
      if (entry && entry.controller === controller) {
        ctx.inFlight.delete(workerId);
      }
    });

  ctx.inFlight.set(workerId, { controller, promise });
}

async function refreshUsage(ctx: Ctx, meta: WorkerMeta): Promise<WorkerMeta> {
  if (!meta.baseUrl || !meta.sessionId) {
    return meta;
  }
  try {
    const usage = await ctx.client.getUsage(meta.baseUrl, meta.sessionId);
    return { ...meta, usage };
  } catch {
    return meta;
  }
}

async function onPromptSettled(ctx: Ctx, workerId: string, result: PromptResult): Promise<void> {
  let meta = await loadMetaIfExists(ctx, workerId);
  if (!meta || meta.state !== "running") {
    // Already forced elsewhere (status() reconciliation raced us) — no-op.
    return;
  }

  if (result.outcome === "completed") {
    meta = await refreshUsage(ctx, { ...meta, state: "completed", updatedAt: Date.now() });
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", from: "running", to: "completed", eventCount: result.eventCount });
    return;
  }

  if (result.outcome === "aborted") {
    meta = { ...meta, state: "aborted", updatedAt: Date.now() };
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", from: "running", to: "aborted" });
    return;
  }

  // outcome === "error": a transport-level signal (dropped stream, HTTP
  // failure, ...) per opencode-client/types.ts's PromptResult docstring.
  meta = {
    ...meta,
    state: "failed",
    lastError: { message: result.error ?? "prompt turn reported an error", classification: "infra" },
    updatedAt: Date.now()
  };
  await persist(ctx, meta);
  await logEvent(ctx, workerId, { type: "state", from: "running", to: "failed", reason: meta.lastError!.message });
}

async function onPromptRejected(ctx: Ctx, workerId: string, err: unknown): Promise<void> {
  const meta = await loadMetaIfExists(ctx, workerId);
  if (!meta || meta.state !== "running") {
    return;
  }
  const next: WorkerMeta = {
    ...meta,
    state: "failed",
    lastError: { message: errMessage(err), classification: "infra" },
    updatedAt: Date.now()
  };
  await persist(ctx, next);
  await logEvent(ctx, workerId, { type: "state", from: "running", to: "failed", reason: next.lastError!.message });
}

async function onTimeout(ctx: Ctx, workerId: string, controller: AbortController): Promise<void> {
  const meta = await loadMetaIfExists(ctx, workerId);
  if (!meta || meta.state !== "running") {
    return;
  }

  controller.abort();
  if (meta.baseUrl && meta.sessionId) {
    try {
      await ctx.client.abort(meta.baseUrl, meta.sessionId);
    } catch {
      // Best-effort: the worker is being marked timed-out regardless.
    }
  }

  const next: WorkerMeta = {
    ...meta,
    state: "timeout",
    // "turn budget exhausted" is ARCHITECTURE.md's own example of a logic
    // failure — it counts against replan budget, unlike a transport error.
    lastError: { message: `worker exceeded its ${ctx.timeoutMs}ms turn budget`, classification: "logic" },
    updatedAt: Date.now()
  };
  await persist(ctx, next);
  await logEvent(ctx, workerId, { type: "state", from: "running", to: "timeout" });
  ctx.inFlight.delete(workerId);
}

// ---------------------------------------------------------------------------
// status / list
// ---------------------------------------------------------------------------

/**
 * Post-restart reconciliation for a worker stuck at `running` with no
 * in-process promise tracking it: polls the live session and, if it's no
 * longer busy, moves the worker to a terminal state.
 *
 * The `getSessionStatus` round-trip below is a window in which a concurrent
 * writer — most notably `abortWorker`, which targets the exact same
 * `state === "running"` condition — can legally transition this worker away
 * from `running` before this function decides what to persist. To avoid
 * clobbering that, the read-decide-write is redone atomically as a single
 * `withWorkerIo` step right before persisting: only if the freshest on-disk
 * state is *still* `running` at that instant does the reconciled state get
 * written. Otherwise the fresher state (e.g. `aborted`) wins untouched.
 */
async function reconcileRunningWorker(ctx: Ctx, workerId: string, meta: WorkerMeta): Promise<WorkerMeta> {
  let next: { state: "completed" | "orphaned"; lastError?: WorkerMeta["lastError"]; reason?: string } | undefined;

  try {
    if (!meta.baseUrl || !meta.sessionId) {
      throw new Error("worker is 'running' but has no baseUrl/sessionId to poll");
    }
    const sessionStatus = await ctx.client.getSessionStatus(meta.baseUrl, meta.sessionId);
    if (sessionStatus.state === "idle") {
      next = { state: "completed", reason: "reconciled via status()" };
    } else if (sessionStatus.state === "unknown") {
      next = {
        state: "orphaned",
        lastError: { message: "session status unknown after restart", classification: "infra" }
      };
    }
    // "busy" -> still running, nothing to reconcile.
  } catch (err) {
    next = {
      state: "orphaned",
      lastError: { message: errMessage(err), classification: "infra" },
      reason: errMessage(err)
    };
  }

  if (!next) {
    return meta;
  }

  return withWorkerIo(ctx, workerId, async () => {
    const fresh = await readJsonIfExists<WorkerMeta>(metaPath(ctx, workerId));
    if (!fresh || fresh.state !== "running") {
      // A concurrent writer (e.g. abortWorker) already moved this worker
      // off 'running' while the getSessionStatus round-trip above was in
      // flight — leave it alone rather than overwriting a newer state.
      return fresh ?? meta;
    }
    const written: WorkerMeta = {
      ...fresh,
      state: next.state,
      lastError: next.lastError ?? fresh.lastError,
      updatedAt: Date.now()
    };
    await atomicWriteJson(metaPath(ctx, workerId), written);
    await logEvent(ctx, workerId, {
      type: "state",
      from: "running",
      to: next.state,
      ...(next.reason ? { reason: next.reason } : {})
    });
    return written;
  });
}

async function statusWorker(ctx: Ctx, workerId: string): Promise<WorkerMeta> {
  let meta = await loadMeta(ctx, workerId);

  if (meta.state === "running" && !ctx.inFlight.has(workerId)) {
    // Post-restart case: no in-process promise is tracking this worker's
    // prompt turn, so reconcile against the live session instead.
    meta = await reconcileRunningWorker(ctx, workerId, meta);
  }

  if (meta.baseUrl && meta.sessionId) {
    try {
      const usage = await ctx.client.getUsage(meta.baseUrl, meta.sessionId);
      // Re-read the freshest on-disk snapshot right before persisting: the
      // `getUsage` await above is a window where a concurrent writer (e.g.
      // the background prompt lifecycle's timeout/completion handler) may
      // have already moved this worker's state on. Persisting the `meta`
      // snapshot captured at the top of this function would silently
      // clobber that newer state with a stale one.
      const fresh = await loadMeta(ctx, workerId);
      meta = { ...fresh, usage, updatedAt: Date.now() };
      await persist(ctx, meta);
    } catch {
      // Best-effort: keep whatever `meta` already holds.
    }
  }

  return meta;
}

async function listWorkers(ctx: Ctx): Promise<WorkerMeta[]> {
  const ids = await listWorkerIds(ctx);
  const metas: WorkerMeta[] = [];
  for (const id of ids) {
    metas.push(await loadMeta(ctx, id));
  }
  return metas;
}

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

async function abortWorker(ctx: Ctx, workerId: string, reason: string): Promise<WorkerMeta> {
  const meta = await loadMeta(ctx, workerId);
  assertState(meta, ABORTABLE_STATES, "abort");

  const inflight = ctx.inFlight.get(workerId);
  if (inflight) {
    inflight.controller.abort();
    ctx.inFlight.delete(workerId);
  }
  if (meta.baseUrl && meta.sessionId) {
    try {
      await ctx.client.abort(meta.baseUrl, meta.sessionId);
    } catch {
      // Best-effort: still transitions to 'aborted' below.
    }
  }

  const next: WorkerMeta = {
    ...meta,
    state: "aborted",
    lastError: { message: reason, classification: "infra" },
    updatedAt: Date.now()
  };
  await persist(ctx, next);
  await logEvent(ctx, workerId, { type: "state", from: meta.state, to: "aborted", reason });
  return next;
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

async function collectWorker(ctx: Ctx, workerId: string): Promise<CollectResult> {
  const meta = await loadMeta(ctx, workerId);
  if (!meta.worktreePath) {
    return { meta, filesChanged: [], diffstat: "" };
  }

  const baseRef = meta.baseRef ?? "HEAD";
  const worktreePath = meta.worktreePath;

  // Cheap insurance: a worktree that was never fully provisioned or was
  // partially removed can still exist as a plain directory. Without this,
  // git would silently walk up to whatever enclosing repo it finds and
  // produce garbage diffs/status for a completely unrelated repository.
  await assertIsWorktreeRoot(worktreePath);

  const committedNames = await runGit(["diff", "--name-only", `${baseRef}..HEAD`], worktreePath)
    .then((r) => splitLines(r.stdout))
    .catch(() => [] as string[]);
  const diffstat = await runGit(["diff", "--stat", `${baseRef}..HEAD`], worktreePath)
    .then((r) => r.stdout)
    .catch(() => "");
  const statusOut = await runGit(["status", "--porcelain"], worktreePath)
    .then((r) => r.stdout)
    .catch(() => "");
  // Porcelain format is "XY <path>" (or "XY old -> new" for renames); the
  // path starts at offset 3 for the common (non-rename) case.
  const uncommittedNames = splitLines(statusOut).map((line) => line.slice(3).trim());

  const filesChanged = [...new Set([...committedNames, ...uncommittedNames])];
  return { meta, filesChanged, diffstat };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

async function verifyWorker(ctx: Ctx, workerId: string, command: string, timeoutMs?: number): Promise<WorkerMeta> {
  let meta = await loadMeta(ctx, workerId);
  assertState(meta, VERIFIABLE_STATES, "verify");
  const worktreePath = meta.worktreePath;
  if (!worktreePath) {
    throw new Error(`Worker '${workerId}' has no worktree to verify`);
  }

  const from = meta.state;
  meta = { ...meta, state: "verifying", updatedAt: Date.now() };
  await persist(ctx, meta);
  await logEvent(ctx, workerId, { type: "state", from, to: "verifying" });

  let result: VerifyResult;
  try {
    result = await runVerification({ cwd: worktreePath, command, timeoutMs });
  } catch (err) {
    // runVerification() rejects (rather than resolving {passed:false}) only
    // for a process/transport-layer failure (e.g. the worktree vanished
    // out from under us) — not a failing command. 'verifying' is absent
    // from every other state-list constant in this module, so leaving it
    // persisted here would wedge the worker forever; revert to 'completed'
    // (which VERIFIABLE_STATES does include, so a retry is still possible)
    // and rethrow so the caller still sees the failure.
    meta = {
      ...meta,
      state: "completed",
      lastError: { message: errMessage(err), classification: "infra" },
      updatedAt: Date.now()
    };
    await persist(ctx, meta);
    await logEvent(ctx, workerId, {
      type: "state",
      from: "verifying",
      to: "completed",
      reason: meta.lastError!.message
    });
    throw err;
  }
  const nextState: WorkerState = result.passed ? "verified" : "verification_failed";

  meta = {
    ...meta,
    state: nextState,
    verify: { passed: result.passed, exitCode: result.exitCode, timedOut: result.timedOut, at: Date.now() },
    lastError: result.passed
      ? undefined
      : { message: `verification failed (exit ${String(result.exitCode)})`, classification: "logic" },
    updatedAt: Date.now()
  };
  await persist(ctx, meta);
  await logEvent(ctx, workerId, {
    type: "verify",
    passed: result.passed,
    exitCode: result.exitCode,
    timedOut: result.timedOut
  });
  await logEvent(ctx, workerId, { type: "state", from: "verifying", to: nextState });
  return meta;
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

async function finalizeWorker(
  ctx: Ctx,
  workerId: string,
  action: "merge" | "discard",
  targetBranch?: string
): Promise<WorkerMeta> {
  let meta = await loadMeta(ctx, workerId);

  if (action === "discard") {
    assertState(meta, DISCARDABLE_STATES, "discard");
    if (meta.worktreePath) {
      await removeWorktree({
        repoDir: ctx.repoDir,
        worktreePath: meta.worktreePath,
        force: true,
        deleteBranch: meta.branchName
      });
    }
    const from = meta.state;
    meta = { ...meta, state: "discarded", updatedAt: Date.now() };
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "state", from, to: "discarded" });
    return meta;
  }

  assertState(meta, ["verified"], "merge");
  if (!meta.worktreePath || !meta.branchName) {
    throw new Error(`Worker '${workerId}' has no worktree/branch to merge`);
  }
  const worktreePath = meta.worktreePath;
  const branchName = meta.branchName;

  // The auto-commit and merge/cleanup git calls below are wrapped as a unit:
  // an unexpected git failure (as opposed to a real merge conflict, which
  // `mergeBranch` reports as a normal `{merged:false}` result rather than
  // throwing) must not leave the worker half-transitioned into 'merged'
  // without an actual successful merge. On catch, `state` is left at
  // 'verified' (retryable) with the failure recorded, and rethrown so the
  // caller sees it.
  try {
    // Structural safety check, before ANY git command (let alone a
    // mutating one) runs with this worktree as cwd: a worktree that was
    // never fully provisioned or was left behind by a partial removal can
    // still exist as a plain directory. Without this, `git add -A && git
    // commit` below would silently walk up to whatever enclosing repo git
    // finds and commit into THAT repo instead — see assertIsWorktreeRoot's
    // docstring for the production incident this guards against.
    await assertIsWorktreeRoot(worktreePath);

    // Workers may or may not commit their own work; finalize commits
    // whatever is left uncommitted so the merge captures it.
    const dirty = await runGit(["status", "--porcelain"], worktreePath);
    if (dirty.stdout.trim().length > 0) {
      await runGit(["add", "-A"], worktreePath);
      await runGit(["commit", "-m", `agentic worker ${workerId}`], worktreePath);
    }

    const target = targetBranch ?? meta.baseRef ?? "main";
    const result = await mergeBranch({ repoDir: ctx.repoDir, sourceBranch: branchName, targetBranch: target });

    if (!result.merged) {
      meta = {
        ...meta,
        merge: { merged: false, conflictFiles: result.conflictFiles, at: Date.now() },
        updatedAt: Date.now()
      };
      await persist(ctx, meta);
      await logEvent(ctx, workerId, { type: "merge", merged: false, conflictFiles: result.conflictFiles });
      // Caller decides what to do about a conflict; state stays 'verified'.
      return meta;
    }

    await removeWorktree({ repoDir: ctx.repoDir, worktreePath, deleteBranch: branchName });

    meta = {
      ...meta,
      state: "merged",
      merge: { merged: true, mergeSha: result.mergeSha, at: Date.now() },
      updatedAt: Date.now()
    };
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "merge", merged: true, mergeSha: result.mergeSha });
    await logEvent(ctx, workerId, { type: "state", from: "verified", to: "merged" });
    return meta;
  } catch (err) {
    meta = {
      ...meta,
      lastError: { message: errMessage(err), classification: "infra" },
      updatedAt: Date.now()
    };
    await persist(ctx, meta);
    await logEvent(ctx, workerId, { type: "merge", merged: false, error: errMessage(err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

async function reconcileWorkers(ctx: Ctx): Promise<WorkerMeta[]> {
  const ids = await listWorkerIds(ctx);
  const changed: WorkerMeta[] = [];
  for (const id of ids) {
    const meta = await loadMeta(ctx, id);
    if (CRASHED_MID_SPAWN_STATES.includes(meta.state)) {
      const next: WorkerMeta = {
        ...meta,
        state: "orphaned",
        lastError: { message: "crashed mid-spawn (found by reconcile)", classification: "infra" },
        updatedAt: Date.now()
      };
      await persist(ctx, next);
      await logEvent(ctx, id, { type: "state", from: meta.state, to: "orphaned", reason: "reconcile" });
      changed.push(next);
    }
  }
  return changed;
}
