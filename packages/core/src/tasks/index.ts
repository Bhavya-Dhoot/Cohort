import { atomicWriteJson, readJsonIfExists } from "../lib/fs.js";
import type { TaskCard, TaskCardStatus } from "./schema.js";

export * from "./schema.js";
export * from "./dag.js";

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  taskType?: string;
  status: TaskStatus;
  workerId?: string;
  createdAt: number;
  updatedAt: number;
  meta?: Record<string, unknown>;
}

interface TaskBoard {
  tasks: TaskRecord[];
}

/**
 * Task record store bound to one `task-board.json` path. Keeps an in-memory
 * map that mirrors the file; `put` upserts by id and persists the whole
 * board atomically. Flat and boring on purpose — DAG/dependency fields
 * arrive in M2.
 */
export class TaskStore {
  private readonly filePath: string;
  private tasks = new Map<string, TaskRecord>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const board = await readJsonIfExists<TaskBoard>(this.filePath);
    this.tasks = new Map((board?.tasks ?? []).map((task) => [task.id, task]));
  }

  async put(task: TaskRecord): Promise<void> {
    const stored: TaskRecord = { ...task, updatedAt: Date.now() };
    this.tasks.set(stored.id, stored);
    await atomicWriteJson(this.filePath, { tasks: [...this.tasks.values()] });
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskStatus }): TaskRecord[] {
    const all = [...this.tasks.values()];
    if (!filter?.status) {
      return all;
    }
    return all.filter((task) => task.status === filter.status);
  }
}

interface TaskCardBoard {
  tasks: TaskCard[];
}

/**
 * DAG-aware sibling to `TaskStore` for the M2 `TaskCard` shape
 * (dependsOn/fileOwnership/etc). A separate class rather than widening
 * `TaskStore` in place, so the M1 `TaskStore`/`TaskRecord` API and its
 * on-disk shape stay untouched. Persists `TaskCard[]` to one
 * `task-board.json`-shaped path atomically, same load/upsert pattern as
 * `TaskStore`.
 */
export class TaskCardStore {
  private readonly filePath: string;
  private tasks = new Map<string, TaskCard>();

  /**
   * Chains every `persist()` write behind the previous one, same technique
   * as `openEventLog`'s `append` (`events/index.ts`). Without this, two
   * concurrent mutators (e.g. `next_batch`'s markAssigned racing
   * `replan_record`'s putMany) can each snapshot the in-memory map and call
   * `atomicWriteJson`, and their underlying write-tmp+rename sequences can
   * finish in an order that doesn't match the order the snapshots were
   * taken -- so a later, more-complete write can be silently clobbered by
   * an earlier, stale one that simply finishes its I/O later. Deferring the
   * snapshot (`[...this.tasks.values()]`) into the chained callback, rather
   * than capturing it up front, also ensures each write reflects every
   * mutation queued ahead of it -- i.e. the snapshot is taken only after
   * the prior write's rename has completed.
   */
  private ioChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const board = await readJsonIfExists<TaskCardBoard>(this.filePath);
    this.tasks = new Map((board?.tasks ?? []).map((task) => [task.id, task]));
  }

  private persist(): Promise<void> {
    const task = this.ioChain.then(() =>
      atomicWriteJson(this.filePath, { tasks: [...this.tasks.values()] })
    );
    // Keep the chain alive even if this write fails, so later writes still
    // run (and still see the failure via their own `task`).
    this.ioChain = task.catch(() => undefined);
    return task;
  }

  /**
   * Insert-or-update by id. Stays a plain upsert (unlike `putMany`, see
   * below) because the one production call site that mutates an
   * *already-existing* card -- `integrate_batch` flipping a card to
   * `done`/`failed` after a merge -- legitimately needs to overwrite a
   * card that's `assigned`/`running`. Callers minting brand-new cards
   * (`plan_submit`, `replan_record`) use `putMany` instead, which does
   * guard against id collisions.
   */
  async put(task: TaskCard): Promise<void> {
    const stored: TaskCard = { ...task, updatedAt: Date.now() };
    this.tasks.set(stored.id, stored);
    await this.persist();
  }

  /**
   * Upserts many cards in one atomic write instead of one write per card.
   * Insert-only by contract: rejects (before writing anything) if any
   * incoming id already exists in the store. This is the write path
   * `plan_submit`/`replan_record` use to seed brand-new `pending` cards,
   * where a colliding id means a duplicate/accidental resubmission that
   * would otherwise silently revert a live `assigned`/`running` card (or
   * an already-`done` one) back to `pending` -- see `put`'s doc comment
   * for the mutate-an-existing-card path that's still allowed.
   */
  async putMany(tasks: TaskCard[]): Promise<void> {
    const collisions = tasks.filter((task) => this.tasks.has(task.id)).map((task) => task.id);
    if (collisions.length > 0) {
      throw new Error(
        `TaskCardStore.putMany: task id(s) already exist: ${collisions.join(", ")}`
      );
    }
    const now = Date.now();
    for (const task of tasks) {
      this.tasks.set(task.id, { ...task, updatedAt: now });
    }
    await this.persist();
  }

  get(id: string): TaskCard | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskCardStatus }): TaskCard[] {
    const all = [...this.tasks.values()];
    if (!filter?.status) {
      return all;
    }
    return all.filter((task) => task.status === filter.status);
  }

  /**
   * Flips `pending` -> `assigned` for `taskIds` and stamps `meta.batchId`.
   * Ids that are missing or not currently `pending` are left untouched
   * (silent no-op per id) rather than throwing, since a batch selection
   * result and the store can race in principle and this is meant to be
   * safe to call with exactly what `selectBatch` returned.
   */
  async markAssigned(taskIds: string[], batchId: string): Promise<void> {
    const now = Date.now();
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (!task || task.status !== "pending") {
        continue;
      }
      this.tasks.set(id, {
        ...task,
        status: "assigned",
        updatedAt: now,
        meta: { ...task.meta, batchId }
      });
    }
    await this.persist();
  }
}
