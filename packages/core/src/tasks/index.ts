import { atomicWriteJson, readJsonIfExists } from "../lib/fs.js";

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
