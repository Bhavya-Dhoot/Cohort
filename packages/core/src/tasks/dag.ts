import type { TaskCard } from "./schema.js";

/**
 * Pure, IO-free DAG operations over `TaskCard[]`: cycle/dangling-dep
 * validation, a conservative glob-overlap test, and batch selection that
 * combines dependency-readiness with file-ownership partitioning. Nothing
 * here touches disk — callers (the store, MCP tools) own persistence.
 */

export interface DanglingDep {
  taskId: string;
  missing: string[];
}

export interface DagValidation {
  valid: boolean;
  /** Each entry is the ordered list of task ids forming one cycle (e.g. A depends on B depends on A -> ["A","B"]). */
  cycles: string[][];
  danglingDeps: DanglingDep[];
}

/**
 * Detects `dependsOn` cycles and dangling references (ids that don't exist
 * in `tasks`). Cycle edges through a dangling id are ignored for cycle
 * detection (they're already reported as dangling); this keeps the two
 * checks orthogonal instead of one masking the other.
 */
export function validateDag(tasks: TaskCard[]): DagValidation {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const danglingDeps: DanglingDep[] = [];
  for (const task of tasks) {
    const missing = task.dependsOn.filter((dep) => !byId.has(dep));
    if (missing.length > 0) {
      danglingDeps.push({ taskId: task.id, missing });
    }
  }

  const cycles: string[][] = [];
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const task of tasks) {
    color.set(task.id, WHITE);
  }
  const stack: string[] = [];

  function visit(id: string): void {
    color.set(id, GRAY);
    stack.push(id);
    const task = byId.get(id);
    if (task) {
      for (const dep of task.dependsOn) {
        if (!byId.has(dep)) {
          continue; // dangling, already reported above
        }
        const depColor = color.get(dep);
        if (depColor === GRAY) {
          const idx = stack.indexOf(dep);
          cycles.push(stack.slice(idx));
        } else if (depColor === WHITE) {
          visit(dep);
        }
      }
    }
    stack.pop();
    color.set(id, BLACK);
  }

  // Sorted iteration order so which cycle representative gets reported is
  // deterministic across runs.
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (color.get(task.id) === WHITE) {
      visit(task.id);
    }
  }

  return {
    valid: cycles.length === 0 && danglingDeps.length === 0,
    cycles,
    danglingDeps
  };
}

function isWildcardSegment(segment: string): boolean {
  return segment.includes("*") || segment.includes("?");
}

/**
 * Conservative static overlap test between two fileOwnership glob sets.
 *
 * Bias: two globs are treated as overlapping UNLESS their path segments,
 * compared left-to-right, provably diverge on a literal (non-wildcard)
 * segment before either side introduces a wildcard. As soon as a wildcard
 * segment (contains `*` or `?`) is reached, we stop trying to prove
 * divergence and call it an overlap — a real glob library could tell
 * `src/a-*.ts` from `src/b-*.ts` apart, this hand-rolled version can't and
 * doesn't try. Two literal (no-wildcard-anywhere) globs of different
 * length are NOT treated as one owning a subtree of the other (no implicit
 * directory-prefix semantics) — they only overlap if exactly equal.
 *
 * This bias is deliberate and one-directional: false positives just
 * serialize two tasks that could have run concurrently (safe, just
 * slower); this function must never return false for a pair that could
 * genuinely collide, since that would let two workers write the same file
 * in the same batch.
 */
export function globsOverlap(a: string[], b: string[]): boolean {
  for (const globA of a) {
    for (const globB of b) {
      if (singleGlobOverlap(globA, globB)) {
        return true;
      }
    }
  }
  return false;
}

function singleGlobOverlap(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }

  const segsA = a.split("/");
  const segsB = b.split("/");
  const len = Math.min(segsA.length, segsB.length);

  for (let i = 0; i < len; i++) {
    const segA = segsA[i]!;
    const segB = segsB[i]!;
    if (isWildcardSegment(segA) || isWildcardSegment(segB)) {
      // Can't prove divergence past a wildcard segment -> conservative overlap.
      return true;
    }
    if (segA !== segB) {
      return false; // literal segments diverge -> no overlap
    }
  }

  // All compared segments were literal and equal. Only an overlap if the
  // paths are the same length (i.e. identical) -- a literal prefix with no
  // wildcard anywhere does not imply directory containment.
  return segsA.length === segsB.length;
}

export interface BlockedTask {
  taskId: string;
  reason: string;
}

export interface BatchSelection {
  ready: TaskCard[];
  blocked: BlockedTask[];
}

export interface SelectBatchOptions {
  maxConcurrent: number;
  /** Task ids to leave out of both `ready` and `blocked` entirely. */
  excludeTaskIds?: string[];
}

/**
 * Selects the next batch of DAG-ready, file-ownership-disjoint tasks.
 *
 * A pending task is ready when every `dependsOn` id is `done` AND its
 * `fileOwnership` doesn't overlap (`globsOverlap`) any currently
 * `running`/`assigned` task, nor any task already placed into `ready` in
 * this same call. Candidates are walked in id order so the result is
 * deterministic; the first blocking reason found (deps, then concurrency
 * cap, then ownership) is the one reported per task.
 */
export function selectBatch(tasks: TaskCard[], opts: SelectBatchOptions): BatchSelection {
  const exclude = new Set(opts.excludeTaskIds ?? []);
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const active = tasks.filter(
    (task) => (task.status === "running" || task.status === "assigned") && !exclude.has(task.id)
  );

  const pending = tasks
    .filter((task) => task.status === "pending" && !exclude.has(task.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const ready: TaskCard[] = [];
  const blocked: BlockedTask[] = [];

  for (const task of pending) {
    const unmetDeps = task.dependsOn.filter((dep) => byId.get(dep)?.status !== "done");
    if (unmetDeps.length > 0) {
      blocked.push({ taskId: task.id, reason: `waiting on deps: ${unmetDeps.join(",")}` });
      continue;
    }

    if (ready.length >= opts.maxConcurrent) {
      blocked.push({ taskId: task.id, reason: "concurrency cap" });
      continue;
    }

    const activeConflict = active.find((other) => globsOverlap(task.fileOwnership, other.fileOwnership));
    if (activeConflict) {
      blocked.push({ taskId: task.id, reason: `file-ownership conflict with ${activeConflict.id}` });
      continue;
    }

    const readyConflict = ready.find((other) => globsOverlap(task.fileOwnership, other.fileOwnership));
    if (readyConflict) {
      blocked.push({ taskId: task.id, reason: `file-ownership conflict with ${readyConflict.id}` });
      continue;
    }

    ready.push(task);
  }

  return { ready, blocked };
}
