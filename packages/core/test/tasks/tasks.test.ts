import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore, type TaskRecord } from "../../src/tasks/index.js";

let dir: string;
let filePath: string;

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    id: "t1",
    title: "Do the thing",
    prompt: "Do the thing please",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

beforeEach(() => {
  dir = join(tmpdir(), `agentic-os-tasks-test-${randomBytes(6).toString("hex")}`);
  filePath = join(dir, "task-board.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("load", () => {
  it("starts empty when the file does not exist", async () => {
    const store = new TaskStore(filePath);
    await store.load();
    expect(store.list()).toEqual([]);
  });
});

describe("put/get/list", () => {
  it("put then get returns the same task", async () => {
    const store = new TaskStore(filePath);
    await store.load();
    const task = makeTask();
    await store.put(task);

    expect(store.get("t1")).toMatchObject({ id: "t1", title: "Do the thing" });
  });

  it("get returns undefined for an unknown id", async () => {
    const store = new TaskStore(filePath);
    await store.load();
    expect(store.get("missing")).toBeUndefined();
  });

  it("list with no filter returns all tasks; filter by status narrows", async () => {
    const store = new TaskStore(filePath);
    await store.load();
    await store.put(makeTask({ id: "a", status: "pending" }));
    await store.put(makeTask({ id: "b", status: "running" }));
    await store.put(makeTask({ id: "c", status: "pending" }));

    expect(store.list().map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    expect(
      store
        .list({ status: "pending" })
        .map((t) => t.id)
        .sort()
    ).toEqual(["a", "c"]);
    expect(store.list({ status: "failed" })).toEqual([]);
  });

  it("put upserts by id and bumps updatedAt", async () => {
    const store = new TaskStore(filePath);
    await store.load();
    const task = makeTask({ updatedAt: 1 });
    await store.put(task);
    const firstUpdatedAt = store.get("t1")!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.put({ ...task, status: "running" });

    const updated = store.get("t1")!;
    expect(updated.status).toBe("running");
    expect(updated.updatedAt).toBeGreaterThan(firstUpdatedAt);
    expect(store.list()).toHaveLength(1);
  });
});

describe("reload from disk", () => {
  it("round-trips through a fresh TaskStore instance", async () => {
    const store = new TaskStore(filePath);
    await store.load();
    await store.put(makeTask({ id: "a", status: "pending" }));
    await store.put(makeTask({ id: "b", status: "done" }));

    const reopened = new TaskStore(filePath);
    await reopened.load();

    expect(reopened.list().map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(reopened.get("b")).toMatchObject({ id: "b", status: "done" });
  });
});
