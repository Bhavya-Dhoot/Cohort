import { describe, expect, it } from "vitest";
import { globsOverlap, selectBatch, validateDag } from "../../src/tasks/dag.js";
import type { TaskCard } from "../../src/tasks/schema.js";

function makeCard(overrides: Partial<TaskCard> = {}): TaskCard {
  const now = Date.now();
  return {
    id: "t1",
    title: "Do the thing",
    prompt: "Do the thing please",
    status: "pending",
    dependsOn: [],
    fileOwnership: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("validateDag", () => {
  it("is valid for an empty task list", () => {
    expect(validateDag([])).toEqual({ valid: true, cycles: [], danglingDeps: [] });
  });

  it("is valid for a linear chain with no cycle or dangling deps", () => {
    const tasks = [
      makeCard({ id: "A", dependsOn: [] }),
      makeCard({ id: "B", dependsOn: ["A"] }),
      makeCard({ id: "C", dependsOn: ["B"] })
    ];
    const result = validateDag(tasks);
    expect(result.valid).toBe(true);
    expect(result.cycles).toEqual([]);
    expect(result.danglingDeps).toEqual([]);
  });

  it("detects a two-node cycle (A -> B -> A) and returns the node list", () => {
    const tasks = [makeCard({ id: "A", dependsOn: ["B"] }), makeCard({ id: "B", dependsOn: ["A"] })];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]!.sort()).toEqual(["A", "B"]);
  });

  it("detects a self-loop", () => {
    const tasks = [makeCard({ id: "A", dependsOn: ["A"] })];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
    expect(result.cycles).toEqual([["A"]]);
  });

  it("reports dangling deps for ids that do not exist", () => {
    const tasks = [makeCard({ id: "A", dependsOn: ["ghost"] })];
    const result = validateDag(tasks);
    expect(result.valid).toBe(false);
    expect(result.cycles).toEqual([]);
    expect(result.danglingDeps).toEqual([{ taskId: "A", missing: ["ghost"] }]);
  });

  it("does not let a dangling dep masquerade as a cycle", () => {
    const tasks = [makeCard({ id: "A", dependsOn: ["ghost"] }), makeCard({ id: "B", dependsOn: ["A"] })];
    const result = validateDag(tasks);
    expect(result.cycles).toEqual([]);
    expect(result.danglingDeps).toEqual([{ taskId: "A", missing: ["ghost"] }]);
  });
});

describe("globsOverlap", () => {
  it("treats identical globs as overlapping", () => {
    expect(globsOverlap(["src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(globsOverlap(["src/a.ts"], ["src/a.ts"])).toBe(globsOverlap(["src/a.ts"], ["src/a.ts"]));
  });

  it("treats disjoint wildcard subtrees as non-overlapping, both directions", () => {
    expect(globsOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
    expect(globsOverlap(["src/b/**"], ["src/a/**"])).toBe(false);
  });

  it("treats a wildcard subtree as overlapping a file inside it, both directions", () => {
    expect(globsOverlap(["src/**"], ["src/a/x.ts"])).toBe(true);
    expect(globsOverlap(["src/a/x.ts"], ["src/**"])).toBe(true);
  });

  it("treats disjoint literal top-level directories as non-overlapping, both directions", () => {
    expect(globsOverlap(["packages/core/**"], ["packages/plugin/**"])).toBe(false);
    expect(globsOverlap(["packages/plugin/**"], ["packages/core/**"])).toBe(false);
  });

  it("conservatively overlaps a partial-literal wildcard segment, both directions", () => {
    expect(globsOverlap(["src/*.ts"], ["src/index.ts"])).toBe(true);
    expect(globsOverlap(["src/index.ts"], ["src/*.ts"])).toBe(true);
  });

  it("does not treat a literal path as owning a deeper literal subpath (no wildcard anywhere)", () => {
    expect(globsOverlap(["src/a.ts"], ["src/a.ts/sub"])).toBe(false);
    expect(globsOverlap(["src/a.ts/sub"], ["src/a.ts"])).toBe(false);
  });

  it("overlaps if any pair across two glob sets overlaps", () => {
    expect(globsOverlap(["docs/**", "src/a/**"], ["src/a/x.ts"])).toBe(true);
  });

  it("is false for empty glob sets", () => {
    expect(globsOverlap([], ["src/a.ts"])).toBe(false);
    expect(globsOverlap([], [])).toBe(false);
  });
});

describe("selectBatch", () => {
  it("gates a task on unmet deps with a deps reason", () => {
    const tasks = [
      makeCard({ id: "A", status: "pending", dependsOn: [], fileOwnership: ["src/a.ts"] }),
      makeCard({ id: "B", status: "pending", dependsOn: ["A"], fileOwnership: ["src/b.ts"] })
    ];
    const { ready, blocked } = selectBatch(tasks, { maxConcurrent: 5 });
    expect(ready.map((t) => t.id)).toEqual(["A"]);
    expect(blocked).toEqual([{ taskId: "B", reason: "waiting on deps: A" }]);
  });

  it("lets a task through once its dep is done", () => {
    const tasks = [
      makeCard({ id: "A", status: "done", dependsOn: [], fileOwnership: ["src/a.ts"] }),
      makeCard({ id: "B", status: "pending", dependsOn: ["A"], fileOwnership: ["src/b.ts"] })
    ];
    const { ready, blocked } = selectBatch(tasks, { maxConcurrent: 5 });
    expect(ready.map((t) => t.id)).toEqual(["B"]);
    expect(blocked).toEqual([]);
  });

  it("serializes two ready tasks with overlapping ownership, selecting only the lower id", () => {
    const tasks = [
      makeCard({ id: "A", status: "pending", fileOwnership: ["src/shared.ts"] }),
      makeCard({ id: "B", status: "pending", fileOwnership: ["src/shared.ts"] })
    ];
    const { ready, blocked } = selectBatch(tasks, { maxConcurrent: 5 });
    expect(ready.map((t) => t.id)).toEqual(["A"]);
    expect(blocked).toEqual([{ taskId: "B", reason: "file-ownership conflict with A" }]);
  });

  it("caps ready at maxConcurrent, blocking the rest with a concurrency-cap reason", () => {
    const tasks = [
      makeCard({ id: "A", status: "pending", fileOwnership: ["src/a.ts"] }),
      makeCard({ id: "B", status: "pending", fileOwnership: ["src/b.ts"] }),
      makeCard({ id: "C", status: "pending", fileOwnership: ["src/c.ts"] })
    ];
    const { ready, blocked } = selectBatch(tasks, { maxConcurrent: 1 });
    expect(ready.map((t) => t.id)).toEqual(["A"]);
    expect(blocked).toEqual([
      { taskId: "B", reason: "concurrency cap" },
      { taskId: "C", reason: "concurrency cap" }
    ]);
  });

  it("blocks a pending task that overlaps a currently running task", () => {
    const tasks = [
      makeCard({ id: "R", status: "running", fileOwnership: ["src/shared.ts"] }),
      makeCard({ id: "A", status: "pending", fileOwnership: ["src/shared.ts"] })
    ];
    const { ready, blocked } = selectBatch(tasks, { maxConcurrent: 5 });
    expect(ready).toEqual([]);
    expect(blocked).toEqual([{ taskId: "A", reason: "file-ownership conflict with R" }]);
  });

  it("blocks a pending task that overlaps a currently assigned task", () => {
    const tasks = [
      makeCard({ id: "S", status: "assigned", fileOwnership: ["src/shared.ts"] }),
      makeCard({ id: "A", status: "pending", fileOwnership: ["src/shared.ts"] })
    ];
    const { ready } = selectBatch(tasks, { maxConcurrent: 5 });
    expect(ready).toEqual([]);
  });

  it("excludeTaskIds removes a running task from conflict consideration", () => {
    const tasks = [
      makeCard({ id: "R", status: "running", fileOwnership: ["src/shared.ts"] }),
      makeCard({ id: "A", status: "pending", fileOwnership: ["src/shared.ts"] })
    ];
    const { ready, blocked } = selectBatch(tasks, { maxConcurrent: 5, excludeTaskIds: ["R"] });
    expect(ready.map((t) => t.id)).toEqual(["A"]);
    expect(blocked).toEqual([]);
  });

  it("returns tasks in deterministic id order", () => {
    const tasks = [
      makeCard({ id: "C", status: "pending", fileOwnership: ["src/c.ts"] }),
      makeCard({ id: "A", status: "pending", fileOwnership: ["src/a.ts"] }),
      makeCard({ id: "B", status: "pending", fileOwnership: ["src/b.ts"] })
    ];
    const { ready } = selectBatch(tasks, { maxConcurrent: 5 });
    expect(ready.map((t) => t.id)).toEqual(["A", "B", "C"]);
  });

  it("only considers status:pending tasks as candidates", () => {
    const tasks = [
      makeCard({ id: "D", status: "done", fileOwnership: ["src/d.ts"] }),
      makeCard({ id: "F", status: "failed", fileOwnership: ["src/f.ts"] }),
      makeCard({ id: "K", status: "blocked", fileOwnership: ["src/k.ts"] })
    ];
    const { ready, blocked } = selectBatch(tasks, { maxConcurrent: 5 });
    expect(ready).toEqual([]);
    expect(blocked).toEqual([]);
  });
});
