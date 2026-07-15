import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, readJsonIfExists } from "../lib/fs.js";
import {
  REVIEWER_ID_PATTERN,
  ReviewVerdictInputSchema,
  TASK_ID_PATTERN,
  type ReviewVerdict,
  type ReviewVerdictInput,
  type ReviewVerdictOutcome
} from "./schema.js";

export * from "./schema.js";

/**
 * Storage and querying for reviewer verdicts (`ReviewVerdict`, see
 * `schema.ts`) under `<runDir>/reviews/<taskId>/<reviewerId>-<n>.json`. This
 * module is storage only -- it never runs an LLM and never judges anything;
 * the judgment is produced by Claude reviewer subagents elsewhere and handed
 * to `recordVerdict` for validation and persistence.
 *
 * `n` versions re-reviews instead of overwriting them (a task can go through
 * `revise` -> fix -> re-review, and the history matters for the run report).
 * Computing "next `n`" is a readdir-then-max-then-write sequence, which races
 * under concurrent calls for the *same* task+reviewer (two callers can both
 * read the same max and write the same `n`, silently losing one verdict).
 * Serialized per `taskId:reviewerId` key via an in-memory promise chain --
 * the same technique `memory/index.ts`'s `sectionChains` and
 * `events/index.ts`'s `openEventLog` use for their own counters -- so calls
 * on the same key queue up and each one's readdir only runs after the prior
 * call's write has landed on disk.
 */

export interface RecordVerdictResult {
  reviewerId: string;
  taskId: string;
  path: string;
}

/** The roll-up `summarizeTask` returns; the orchestrator's integrate-vs-replan signal. */
export interface TaskReviewSummary {
  taskId: string;
  /** Worst verdict across every reviewer's *latest* verdict; "none" if no verdicts exist yet. */
  worst: ReviewVerdictOutcome | "none";
  /** Each reviewer's latest verdict. */
  byReviewer: Record<string, ReviewVerdictOutcome>;
  /**
   * True if any reviewer's latest verdict is `block`, OR `revise` that
   * hasn't been superseded by a later `pass`/re-review from the same
   * reviewer. A `revise` is a reviewer saying "this needs changes before
   * I'd sign off" -- treating it as non-blocking would let the orchestrator
   * integrate work no reviewer has actually approved, so `revise` blocks
   * integration exactly like `block` until a newer verdict clears it.
   */
  blocking: boolean;
}

export interface ReviewStore {
  recordVerdict(verdict: ReviewVerdictInput): Promise<RecordVerdictResult>;
  getVerdicts(taskId: string, reviewerId?: string): Promise<ReviewVerdict[]>;
  summarizeTask(taskId: string): Promise<TaskReviewSummary>;
}

const VERDICT_FILENAME_RE = /^(.+)-(\d+)\.json$/;

function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Invalid taskId '${taskId}': must match ${TASK_ID_PATTERN.source}`);
  }
}

function assertValidReviewerId(reviewerId: string): void {
  if (!REVIEWER_ID_PATTERN.test(reviewerId)) {
    throw new Error(`Invalid reviewerId '${reviewerId}': must match ${REVIEWER_ID_PATTERN.source}`);
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Opens a review store rooted at `runDir` (writes/reads never leave
 * `<runDir>/reviews/`). Synchronous (no I/O until a method is called),
 * matching `openEventLog`/`openMemoryStore`.
 */
export function openReviewStore(runDir: string): ReviewStore {
  const reviewsDir = join(runDir, "reviews");

  // Per-`taskId:reviewerId` promise chains -- see the module doc comment.
  const chains = new Map<string, Promise<unknown>>();

  async function recordVerdict(input: ReviewVerdictInput): Promise<RecordVerdictResult> {
    const result = ReviewVerdictInputSchema.safeParse(input);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid review verdict:\n${issues}`);
    }
    const parsed = result.data;
    const verdict: ReviewVerdict = { ...parsed, at: parsed.at ?? Date.now() };
    const { taskId, reviewerId } = verdict;
    const taskDir = join(reviewsDir, taskId);

    const key = `${taskId}:${reviewerId}`;
    const prior = chains.get(key) ?? Promise.resolve();
    const task = prior.then(async (): Promise<RecordVerdictResult> => {
      const entries = await listDir(taskDir);
      const prefix = `${reviewerId}-`;
      let maxIndex = -1;
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const match = VERDICT_FILENAME_RE.exec(entry);
        if (!match || match[1] !== reviewerId) continue;
        const n = Number(match[2]);
        if (n > maxIndex) maxIndex = n;
      }
      const nextIndex = maxIndex + 1;
      const filePath = join(taskDir, `${reviewerId}-${nextIndex}.json`);
      await atomicWriteJson(filePath, verdict);
      return { reviewerId, taskId, path: filePath };
    });
    // Keep the chain alive even if this write fails, so later writes on the
    // same key still run (and still see the failure via their own `task`).
    chains.set(key, task.catch(() => undefined));
    return task;
  }

  async function getVerdicts(taskId: string, reviewerId?: string): Promise<ReviewVerdict[]> {
    assertValidTaskId(taskId);
    if (reviewerId !== undefined) {
      assertValidReviewerId(reviewerId);
    }
    const taskDir = join(reviewsDir, taskId);
    const entries = await listDir(taskDir);

    const candidates: Array<{ file: string; index: number }> = [];
    for (const entry of entries) {
      const match = VERDICT_FILENAME_RE.exec(entry);
      if (!match) continue;
      if (reviewerId !== undefined && match[1] !== reviewerId) continue;
      candidates.push({ file: entry, index: Number(match[2]) });
    }

    const loaded: Array<{ verdict: ReviewVerdict; index: number }> = [];
    for (const candidate of candidates) {
      const data = await readJsonIfExists<ReviewVerdict>(join(taskDir, candidate.file));
      if (data !== undefined) {
        loaded.push({ verdict: data, index: candidate.index });
      }
    }

    // Newest first by `at`; ties (same millisecond) broken by the on-disk
    // version index, which is itself monotonic write order.
    loaded.sort((a, b) => b.verdict.at - a.verdict.at || b.index - a.index);
    return loaded.map((entry) => entry.verdict);
  }

  async function summarizeTask(taskId: string): Promise<TaskReviewSummary> {
    assertValidTaskId(taskId);
    const verdicts = await getVerdicts(taskId); // newest first, all reviewers

    // First occurrence per reviewerId, in newest-first order, is that
    // reviewer's latest verdict.
    const byReviewer: Record<string, ReviewVerdictOutcome> = {};
    for (const v of verdicts) {
      if (!(v.reviewerId in byReviewer)) {
        byReviewer[v.reviewerId] = v.verdict;
      }
    }

    const latest = Object.values(byReviewer);
    let worst: ReviewVerdictOutcome | "none" = "none";
    if (latest.length > 0) {
      worst = latest.includes("block") ? "block" : latest.includes("revise") ? "revise" : "pass";
    }
    const blocking = latest.some((v) => v === "block" || v === "revise");

    return { taskId, worst, byReviewer, blocking };
  }

  return { recordVerdict, getVerdicts, summarizeTask };
}
