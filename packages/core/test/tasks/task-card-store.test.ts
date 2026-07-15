import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskCardStore, type TaskCard } from "../../src/tasks/index.js";

let dir: string;
let filePath: string;

function makeCard(overrides: Partial<TaskCard> = {}): TaskCard {
  const now = Date.now();
  return {
    id: "t1",
    title: "Do the thing",
    prompt: "Do the thing please",
    status: "pending",
    dependsOn: [],
    fileOwnership: ["src/a.ts"],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

beforeEach(() => {
  dir = join(tmpdir(), `agentic-os-taskcard-test-${randomBytes(6).toString("hex")}`);
  filePath = join(dir, "task-board.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TaskCardStore load", () => {
  it("starts empty when the file does not exist", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    expect(store.list()).toEqual([]);
  });
});

describe("TaskCardStore put/get/list", () => {
  it("put then get returns the same card", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard());
    expect(store.get("t1")).toMatchObject({ id: "t1", title: "Do the thing" });
  });

  it("get returns undefined for an unknown id", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    expect(store.get("missing")).toBeUndefined();
  });

  it("list with no filter returns all cards; filter by status narrows", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard({ id: "a", status: "pending" }));
    await store.put(makeCard({ id: "b", status: "running" }));
    await store.put(makeCard({ id: "c", status: "pending" }));

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
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard({ updatedAt: 1 }));
    const firstUpdatedAt = store.get("t1")!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.put(makeCard({ status: "running" }));

    const updated = store.get("t1")!;
    expect(updated.status).toBe("running");
    expect(updated.updatedAt).toBeGreaterThan(firstUpdatedAt);
    expect(store.list()).toHaveLength(1);
  });
});

describe("TaskCardStore putMany", () => {
  it("upserts several cards in one call", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.putMany([makeCard({ id: "a" }), makeCard({ id: "b" }), makeCard({ id: "c" })]);
    expect(store.list().map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("persists so a fresh store reload sees all of them", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.putMany([makeCard({ id: "a" }), makeCard({ id: "b" })]);

    const reopened = new TaskCardStore(filePath);
    await reopened.load();
    expect(reopened.list().map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  it("rejects if an incoming id already exists in the store, naming the colliding id, and leaves the store unchanged", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard({ id: "a", status: "assigned" }));

    await expect(
      store.putMany([makeCard({ id: "b" }), makeCard({ id: "a", status: "pending" })])
    ).rejects.toThrow(/\ba\b/);

    // Whole call rejected up front: "b" (not colliding) must not have been
    // inserted either, and "a" must not have been reverted to pending.
    expect(store.list().map((t) => t.id).sort()).toEqual(["a"]);
    expect(store.get("a")!.status).toBe("assigned");

    const reopened = new TaskCardStore(filePath);
    await reopened.load();
    expect(reopened.list().map((t) => t.id)).toEqual(["a"]);
  });
});

describe("TaskCardStore markAssigned", () => {
  it("flips pending -> assigned and stamps meta.batchId", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.putMany([makeCard({ id: "a" }), makeCard({ id: "b" })]);

    await store.markAssigned(["a", "b"], "batch-1");

    expect(store.get("a")).toMatchObject({ status: "assigned", meta: { batchId: "batch-1" } });
    expect(store.get("b")).toMatchObject({ status: "assigned", meta: { batchId: "batch-1" } });
  });

  it("leaves a non-pending task untouched", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard({ id: "a", status: "done" }));

    await store.markAssigned(["a"], "batch-1");

    expect(store.get("a")!.status).toBe("done");
  });

  it("ignores unknown ids without throwing", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard({ id: "a" }));

    await expect(store.markAssigned(["ghost"], "batch-1")).resolves.toBeUndefined();
  });

  it("persists the assignment across a reload", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard({ id: "a" }));
    await store.markAssigned(["a"], "batch-2");

    const reopened = new TaskCardStore(filePath);
    await reopened.load();
    expect(reopened.get("a")).toMatchObject({ status: "assigned", meta: { batchId: "batch-2" } });
  });
});

describe("TaskCardStore concurrent persists", () => {
  it("markAssigned and putMany run concurrently without losing either update on disk", async () => {
    const store = new TaskCardStore(filePath);
    await store.load();
    await store.put(makeCard({ id: "a", status: "pending" }));

    // Simulates next_batch's markAssigned racing replan_record's putMany
    // against the same shared store -- both mutate the in-memory map
    // synchronously and then race to persist the whole board.
    await Promise.all([
      store.markAssigned(["a"], "batch-1"),
      store.putMany([makeCard({ id: "b", status: "pending" })])
    ]);

    expect(store.get("a")).toMatchObject({ status: "assigned", meta: { batchId: "batch-1" } });
    expect(store.get("b")).toMatchObject({ status: "pending" });

    const reopened = new TaskCardStore(filePath);
    await reopened.load();
    expect(reopened.list().map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(reopened.get("a")).toMatchObject({ status: "assigned", meta: { batchId: "batch-1" } });
    expect(reopened.get("b")).toMatchObject({ status: "pending" });
  });
});
