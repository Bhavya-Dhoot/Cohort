/**
 * Cost accumulation with pre-spawn reservations and tiered guardrails.
 *
 * A worker's actual cost isn't known until it finishes a turn, but the
 * orchestrator must refuse to overspend *before* spawning it (Execution
 * pipeline step 5: "budget tiers checked before each spawn"). `reserve`
 * books a pessimistic estimate against the hard cap up front; `reconcile`
 * replaces that estimate with the real cost once the worker reports usage.
 * Between those two calls, in-flight spend is `committed + reserved`, which
 * is what tiering and the hard-cap refusal are based on (Risks item 5: cost
 * blowup from unmonitored concurrent spawning).
 *
 * Disk is the source of truth: every mutation is persisted via
 * `atomicWriteJson` before it's considered durable, and `createBudgetTracker`
 * reloads the per-worker ledger from disk on construction so a crashed or
 * restarted MCP process resumes with the same committed/reserved totals.
 */

import { atomicWriteJson, readJsonIfExists } from "../lib/fs.js";

export type Tier = "ok" | "soft" | "hard";

export interface ReserveResult {
  allowed: boolean;
  tier: Tier;
  committedUsd: number;
  reservedUsd: number;
}

export interface WorkerBudget {
  reservedUsd?: number;
  committedUsd?: number;
}

export interface BudgetSnapshot {
  committedUsd: number;
  reservedUsd: number;
  tier: Tier;
  perWorker: Record<string, WorkerBudget>;
}

export interface BudgetTracker {
  /**
   * Records a reservation of `estimateUsd` (default `defaultReserveUsd`)
   * against `workerId`. Refused — `allowed: false`, state left untouched —
   * when `committed + reserved + estimate` would exceed `hardCapUsd`, where
   * `reserved` excludes any prior reservation for this same `workerId`
   * (a second `reserve` call for a worker replaces its reservation rather
   * than stacking on top of it).
   */
  reserve(workerId: string, estimateUsd?: number): Promise<ReserveResult>;
  /**
   * Drops `workerId`'s reservation (if any) and adds `actualUsd` to
   * committed cost. Safe to call without a prior `reserve`.
   */
  reconcile(workerId: string, actualUsd: number): Promise<void>;
  /** Current tier from committed + reserved vs. softCapUsd/hardCapUsd. */
  tier(): Tier;
  snapshot(): BudgetSnapshot;
}

export interface CreateBudgetTrackerOptions {
  /** Path to the JSON snapshot file (e.g. `.cohort/runs/<runId>/cost.json`). */
  filePath: string;
  softCapUsd: number;
  hardCapUsd: number;
  /** Reservation used when `reserve` is called without an explicit estimate. */
  defaultReserveUsd?: number;
}

/**
 * Only the per-worker ledger is persisted. `softCapUsd`/`hardCapUsd`/
 * `defaultReserveUsd` come from config and are supplied fresh on every
 * `createBudgetTracker` call rather than frozen into the state file.
 */
interface PersistedState {
  perWorker: Record<string, WorkerBudget>;
}

const DEFAULT_RESERVE_USD = 0.5;
const DECIMALS = 6;
const ROUND_FACTOR = 10 ** DECIMALS;

/** Rounds to 6 decimals so repeated additions don't accumulate float drift. */
function round(n: number): number {
  return Math.round(n * ROUND_FACTOR) / ROUND_FACTOR;
}

export async function createBudgetTracker(
  opts: CreateBudgetTrackerOptions
): Promise<BudgetTracker> {
  const { filePath, softCapUsd, hardCapUsd } = opts;
  const defaultReserveUsd = opts.defaultReserveUsd ?? DEFAULT_RESERVE_USD;

  const loaded = await readJsonIfExists<PersistedState>(filePath);
  const perWorker: Record<string, WorkerBudget> = loaded?.perWorker ?? {};
  // Worker IDs this instance has itself reserved/reconciled. persist() uses
  // this to decide which entries it owns (and may overwrite) versus which
  // belong to another process sharing this file (and must be preserved
  // as-is on write).
  const touchedWorkerIds = new Set<string>();

  function totals(): { committedUsd: number; reservedUsd: number } {
    let committedUsd = 0;
    let reservedUsd = 0;
    for (const w of Object.values(perWorker)) {
      committedUsd += w.committedUsd ?? 0;
      reservedUsd += w.reservedUsd ?? 0;
    }
    return { committedUsd: round(committedUsd), reservedUsd: round(reservedUsd) };
  }

  function computeTier(committedUsd: number, reservedUsd: number): Tier {
    const total = round(committedUsd + reservedUsd);
    if (total >= hardCapUsd) return "hard";
    if (total >= softCapUsd) return "soft";
    return "ok";
  }

  // Every persist() runs strictly after the previous one's rename has
  // completed, chained through `ioChain`: concurrent reserve()/reconcile()
  // calls previously each captured `perWorker` and raced their own
  // read-tmp-write-rename sequences independently, and whichever rename
  // landed last silently overwrote the other's entry (verified empirically
  // -- a lost update, not just a lost reservation check). Chaining through
  // one promise means each write's snapshot is only taken once the prior
  // write is durable on disk.
  let ioChain: Promise<void> = Promise.resolve();

  async function persist(): Promise<void> {
    const task = ioChain.then(async () => {
      // Re-read the file fresh (rather than trusting this instance's
      // long-lived in-memory snapshot) so a second BudgetTracker instance
      // pointed at the same cost.json -- e.g. an orphaned MCP server from a
      // crashed session -- doesn't get its entries clobbered by ours. Only
      // entries for workers *this* instance has touched are overwritten;
      // every other worker's entry is passed through verbatim (per-worker
      // last-writer-wins, never a whole-file overwrite).
      //
      // ponytail: mitigation, not a fix -- there is still no cross-process
      // file lock, so two instances racing to persist the SAME workerId at
      // the same instant can still lose an update (this assumes a workerId
      // is only ever mutated by the one process/tracker that owns it).
      // True multi-writer accuracy needs a real file lock; out of scope
      // for M1.
      const diskState = await readJsonIfExists<PersistedState>(filePath);
      const merged: Record<string, WorkerBudget> = { ...(diskState?.perWorker ?? {}) };
      for (const workerId of touchedWorkerIds) {
        merged[workerId] = perWorker[workerId]!;
      }
      await atomicWriteJson(filePath, { perWorker: merged });
    });
    ioChain = task.catch(() => undefined);
    await task;
  }

  return {
    async reserve(workerId, estimateUsd) {
      const estimate = round(estimateUsd ?? defaultReserveUsd);
      const { committedUsd, reservedUsd } = totals();
      const existingReservation = round(perWorker[workerId]?.reservedUsd ?? 0);
      const reservedExcludingThisWorker = round(reservedUsd - existingReservation);
      const prospectiveTotal = round(
        committedUsd + reservedExcludingThisWorker + estimate
      );

      if (prospectiveTotal > hardCapUsd) {
        return {
          allowed: false,
          tier: computeTier(committedUsd, reservedUsd),
          committedUsd,
          reservedUsd
        };
      }

      perWorker[workerId] = { ...perWorker[workerId], reservedUsd: estimate };
      touchedWorkerIds.add(workerId);
      await persist();

      const after = totals();
      return {
        allowed: true,
        tier: computeTier(after.committedUsd, after.reservedUsd),
        committedUsd: after.committedUsd,
        reservedUsd: after.reservedUsd
      };
    },

    async reconcile(workerId, actualUsd) {
      const priorCommitted = perWorker[workerId]?.committedUsd ?? 0;
      perWorker[workerId] = { committedUsd: round(priorCommitted + actualUsd) };
      touchedWorkerIds.add(workerId);
      await persist();
    },

    tier() {
      const { committedUsd, reservedUsd } = totals();
      return computeTier(committedUsd, reservedUsd);
    },

    snapshot() {
      const { committedUsd, reservedUsd } = totals();
      return {
        committedUsd,
        reservedUsd,
        tier: computeTier(committedUsd, reservedUsd),
        perWorker: { ...perWorker }
      };
    }
  };
}
