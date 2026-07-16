import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateRunReport } from "../../src/report/index.js";
import type { WorkerMeta } from "../../src/worker/types.js";
import type { TaskCard } from "../../src/tasks/schema.js";
import type { ReviewVerdict } from "../../src/review/schema.js";
import type { ReplanRecord } from "../../src/plan/schema.js";

const BASE = 1_700_000_000_000;

let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `cohort-report-test-${randomBytes(6).toString("hex")}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function writeWorker(runDir: string, workerId: string, meta: WorkerMeta): Promise<void> {
  await writeJson(join(runDir, "workers", workerId, "meta.json"), meta);
}

/**
 * Builds a full fixture run directory: 3 tasks (T1 done -> T2 failed,
 * T3 running, both depending on T1), 3 workers (merged/verification_failed
 * with lastError/running), a cost snapshot, a blocking review on T2, and a
 * replan record addressing T2.
 */
async function buildFixture(runDir: string): Promise<void> {
  await writeJson(join(runDir, "plan.json"), {
    objective: "Build the widget",
    tasks: [
      { id: "T1", title: "Scaffold", prompt: "scaffold it", dependsOn: [], fileOwnership: [] },
      { id: "T2", title: "Add tests", prompt: "test it", dependsOn: ["T1"], fileOwnership: [] },
      { id: "T3", title: "Wire UI", prompt: "wire it", dependsOn: ["T1"], fileOwnership: [] }
    ]
  });

  const tasks: TaskCard[] = [
    {
      id: "T1",
      title: "Scaffold",
      prompt: "scaffold it",
      status: "done",
      dependsOn: [],
      fileOwnership: [],
      createdAt: BASE,
      updatedAt: BASE + 5000
    },
    {
      id: "T2",
      title: "Add tests",
      prompt: "test it",
      status: "failed",
      dependsOn: ["T1"],
      fileOwnership: [],
      createdAt: BASE,
      updatedAt: BASE + 8000
    },
    {
      id: "T3",
      title: "Wire UI",
      prompt: "wire it",
      status: "running",
      dependsOn: ["T1"],
      fileOwnership: [],
      createdAt: BASE,
      updatedAt: BASE + 3000
    }
  ];
  await writeJson(join(runDir, "task-board.json"), { tasks });

  await writeWorker(runDir, "w-merged", {
    workerId: "w-merged",
    runId: "run-1",
    taskId: "T1",
    state: "merged",
    prompt: "scaffold it",
    model: "model-a",
    createdAt: BASE,
    updatedAt: BASE + 5000,
    attempts: { infra: 0 },
    usage: { costUsd: 0.05 },
    verify: { passed: true, exitCode: 0, timedOut: false, at: BASE + 4000 },
    merge: { merged: true, mergeSha: "abc123", at: BASE + 5000 }
  });

  await writeWorker(runDir, "w-failed", {
    workerId: "w-failed",
    runId: "run-1",
    taskId: "T2",
    state: "verification_failed",
    prompt: "test it",
    model: "model-b",
    createdAt: BASE + 1000,
    updatedAt: BASE + 8000,
    attempts: { infra: 0 },
    usage: { costUsd: 0.02 },
    lastError: { message: "3 tests failed in suite X", classification: "logic" },
    verify: { passed: false, exitCode: 1, timedOut: false, at: BASE + 7000 }
  });

  await writeWorker(runDir, "w-running", {
    workerId: "w-running",
    runId: "run-1",
    taskId: "T3",
    state: "running",
    prompt: "wire it",
    model: "model-a",
    createdAt: BASE + 2000,
    updatedAt: BASE + 3000,
    attempts: { infra: 0 },
    usage: { costUsd: 0.01 }
  });

  await writeJson(join(runDir, "cost.json"), {
    committedUsd: 0.07,
    reservedUsd: 0.01,
    tier: "ok",
    perWorker: {
      "w-merged": { committedUsd: 0.05 },
      "w-failed": { committedUsd: 0.02 },
      "w-running": { reservedUsd: 0.01 }
    }
  });

  const blockingReview: ReviewVerdict = {
    taskId: "T2",
    reviewerId: "security",
    verdict: "block",
    findings: [{ severity: "critical", note: "SQL injection risk in query builder" }],
    at: BASE + 7500
  };
  await writeJson(join(runDir, "reviews", "T2", "security-0.json"), blockingReview);

  const replan: ReplanRecord = {
    iteration: 1,
    reason: "verification failed for T2",
    affectedTaskIds: ["T2"],
    newTaskIds: [],
    at: BASE + 9000
  };
  await writeJson(join(runDir, "replans", "1.json"), replan);
}

describe("generateRunReport", () => {
  it("renders all sections with correct summary counts for a full fixture", async () => {
    const runDir = join(root, "run-1");
    await buildFixture(runDir);

    const { markdown, summary } = await generateRunReport(runDir);

    // Section headers
    expect(markdown).toContain("# Run Report: run-1");
    expect(markdown).toContain("## Execution Timeline");
    expect(markdown).toContain("## Task DAG");
    expect(markdown).toContain("## Model & Cost Usage");
    expect(markdown).toContain("## Reviews");
    expect(markdown).toContain("## Failure Report");

    // Mermaid fences
    expect(markdown).toContain("```mermaid\ngantt");
    expect(markdown).toContain("```mermaid\ngraph TD");

    // Failure worker's message shows up in the failure report
    expect(markdown).toContain("3 tests failed in suite X");
    expect(markdown).toContain("logic");
    expect(markdown).toContain("addressed by #1");

    // Cost rollup total: model-a = w-merged(0.05) + w-running(0.01) = 0.06
    expect(markdown).toContain("$0.0600");

    // DAG edge from T1 -> T2 / T1 -> T3
    expect(markdown).toContain("T1 --> T2");
    expect(markdown).toContain("T1 --> T3");

    // Summary counts
    expect(summary.runId).toBe("run-1");
    expect(summary.objective).toBe("Build the widget");
    expect(summary.tasks).toEqual({ total: 3, done: 1, failed: 1, pending: 1 });
    expect(summary.workers.total).toBe(3);
    expect(summary.workers.merged).toBe(1);
    expect(summary.workers.failed).toBe(1);
    expect(summary.workers.byState).toEqual({ merged: 1, verification_failed: 1, running: 1 });
    expect(summary.cost).toEqual({ committedUsd: 0.07, tier: "ok" });
    expect(summary.reviews).toEqual({ total: 1, blocking: 1 });
    // min(createdAt)=BASE (w-merged), max(updatedAt)=BASE+8000 (w-failed)
    expect(summary.durationMs).toBe(8000);
  });

  it("never throws on a near-empty run dir and returns a zeroed summary", async () => {
    const runDir = join(root, "empty-run");
    await mkdir(runDir, { recursive: true });

    const { markdown, summary } = await generateRunReport(runDir);

    expect(typeof markdown).toBe("string");
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).toContain("# Run Report: empty-run");
    expect(markdown).toContain("_no data_");

    expect(summary.runId).toBe("empty-run");
    expect(summary.objective).toBeUndefined();
    expect(summary.tasks).toEqual({ total: 0, done: 0, failed: 0, pending: 0 });
    expect(summary.workers).toEqual({ total: 0, merged: 0, failed: 0, byState: {} });
    expect(summary.cost).toEqual({ committedUsd: 0, tier: "ok" });
    expect(summary.reviews).toEqual({ total: 0, blocking: 0 });
    expect(summary.durationMs).toBeUndefined();
  });

  it("still generates a report when cost.json is malformed JSON", async () => {
    const runDir = join(root, "run-malformed-cost");
    await buildFixture(runDir);
    // Overwrite cost.json with invalid JSON.
    await writeFile(join(runDir, "cost.json"), "{ this is not valid json,,,", "utf8");

    const { markdown, summary } = await generateRunReport(runDir);

    expect(typeof markdown).toBe("string");
    expect(markdown.length).toBeGreaterThan(0);
    // Falls back to defaults instead of throwing or propagating garbage.
    expect(summary.cost).toEqual({ committedUsd: 0, tier: "ok" });
    // Other sections built from unaffected artifacts still work.
    expect(summary.tasks.total).toBe(3);
    expect(summary.workers.total).toBe(3);
  });

  it("still generates a report when plan.json and task-board.json are missing", async () => {
    const runDir = join(root, "run-no-plan");
    await mkdir(join(runDir, "workers", "w1"), { recursive: true });
    await writeJson(join(runDir, "workers", "w1", "meta.json"), {
      workerId: "w1",
      runId: "run-no-plan",
      taskId: "orphan-task",
      state: "completed",
      prompt: "do a thing",
      createdAt: BASE,
      updatedAt: BASE + 1000,
      attempts: { infra: 0 }
    } satisfies WorkerMeta);

    const { markdown, summary } = await generateRunReport(runDir);

    expect(markdown).toContain("# Run Report: run-no-plan");
    expect(markdown).toContain("_none recorded_"); // no objective
    expect(markdown).toContain("## Task DAG");
    expect(markdown).toContain("_no data_"); // task DAG has no tasks
    expect(summary.objective).toBeUndefined();
    expect(summary.tasks.total).toBe(0);
    expect(summary.workers.total).toBe(1);
    expect(summary.durationMs).toBe(1000);
  });

  it("drops a worker meta with a non-numeric/missing createdAt, so the report still generates with no NaN/undefined", async () => {
    const runDir = join(root, "run-bad-timestamp");
    // One valid worker plus one with a corrupted createdAt (hand-edited/partial write).
    await writeWorker(runDir, "w-ok", {
      workerId: "w-ok",
      runId: "run-bad-timestamp",
      taskId: "T1",
      state: "completed",
      prompt: "do it",
      createdAt: BASE,
      updatedAt: BASE + 1000,
      attempts: { infra: 0 }
    } satisfies WorkerMeta);
    await writeJson(join(runDir, "workers", "w-bad", "meta.json"), {
      workerId: "w-bad",
      runId: "run-bad-timestamp",
      taskId: "T2",
      state: "running",
      prompt: "do it too",
      createdAt: "not-a-number",
      updatedAt: BASE + 2000,
      attempts: { infra: 0 }
    });
    // Also missing updatedAt entirely.
    await writeJson(join(runDir, "workers", "w-missing", "meta.json"), {
      workerId: "w-missing",
      runId: "run-bad-timestamp",
      taskId: "T3",
      state: "running",
      prompt: "do it three",
      createdAt: BASE,
      attempts: { infra: 0 }
    });

    const { markdown, summary } = await generateRunReport(runDir);

    // Only the valid worker survives.
    expect(summary.workers.total).toBe(1);
    expect(summary.workers.byState).toEqual({ completed: 1 });
    expect(summary.durationMs).toBe(1000);

    expect(markdown).not.toMatch(/NaN/);
    expect(markdown).not.toMatch(/undefined/);
    expect(markdown).not.toMatch(/Invalid Date/);
    expect(markdown).toContain("w-ok");
    expect(markdown).not.toContain("w-bad");
    expect(markdown).not.toContain("w-missing");
  });

  it("escapes a worker state / review verdict containing a pipe or newline so tables aren't corrupted", async () => {
    const runDir = join(root, "run-malicious-fields");
    await writeWorker(runDir, "w-pipe", {
      workerId: "w-pipe",
      runId: "run-malicious-fields",
      taskId: "T1",
      // Cast through unknown: WorkerState is a closed union at the type
      // level, but this simulates a hand-edited/corrupted meta.json where
      // the on-disk value doesn't match the type.
      state: "failed | evil\ninjected row" as unknown as WorkerMeta["state"],
      prompt: "do it",
      createdAt: BASE,
      updatedAt: BASE + 1000,
      attempts: { infra: 0 },
      lastError: { message: "boom", classification: "logic" }
    } satisfies WorkerMeta);

    const goodVerdict: ReviewVerdict = {
      taskId: "T1",
      reviewerId: "security",
      verdict: "pass",
      findings: [],
      at: BASE
    };
    await writeJson(join(runDir, "reviews", "T1", "security-0.json"), goodVerdict);

    const { markdown } = await generateRunReport(runDir);

    // The cost-usage table row for w-pipe must have exactly 5 columns (6 column
    // separators). `escapeTableCell` turns the embedded `|` into `\|`, which
    // still contains a literal `|` character -- so count only *unescaped*
    // pipes (real separators) via a negative lookbehind, not raw `|` chars.
    // Match the actual table row (starts with "| w-pipe |"), not the gantt
    // timeline line above it, which also mentions "w-pipe" as its node id
    // but is mermaid syntax, not a markdown table.
    const costRow = markdown.split("\n").find((line) => /^\|\s*w-pipe\s*\|/.test(line));
    expect(costRow).toBeDefined();
    expect((costRow!.match(/(?<!\\)\|/g) ?? []).length).toBe(6);
    expect(costRow).not.toContain("\n");

    // The failure-report bullet for state is escaped too (no stray newline breaking list structure).
    const stateBullet = markdown.split("\n").find((line) => line.startsWith("- **State:**"));
    expect(stateBullet).toBeDefined();
    expect(stateBullet).toContain("evil");
  });

  it("drops a review verdict with a corrupted (non-enum) value", async () => {
    const runDir = join(root, "run-bad-verdict");
    await writeWorker(runDir, "w1", {
      workerId: "w1",
      runId: "run-bad-verdict",
      taskId: "T1",
      state: "completed",
      prompt: "do it",
      createdAt: BASE,
      updatedAt: BASE + 1000,
      attempts: { infra: 0 }
    } satisfies WorkerMeta);
    // Corrupted verdict value -- not one of pass/revise/block.
    await writeJson(join(runDir, "reviews", "T1", "security-0.json"), {
      taskId: "T1",
      reviewerId: "security",
      verdict: "definitely-maybe",
      findings: [],
      at: BASE
    });

    const { markdown, summary } = await generateRunReport(runDir);

    expect(summary.reviews).toEqual({ total: 0, blocking: 0 });
    expect(markdown).toContain("## Reviews");
    expect(markdown).toContain("_no data_");
  });
});
