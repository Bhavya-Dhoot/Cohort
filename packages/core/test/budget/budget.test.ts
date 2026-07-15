import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudgetTracker } from "../../src/budget/index.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = join(tmpdir(), `agentic-os-budget-test-${randomBytes(6).toString("hex")}`);
  filePath = join(dir, "cost.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("reservation lifecycle", () => {
  it("transitions ok -> soft -> hard as reserve/reconcile cycles accumulate cost", async () => {
    const budget = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });

    const r1 = await budget.reserve("workerA", 5);
    expect(r1).toEqual({ allowed: true, tier: "ok", committedUsd: 0, reservedUsd: 5 });
    await budget.reconcile("workerA", 5);
    expect(budget.tier()).toBe("ok");

    const r2 = await budget.reserve("workerB", 6);
    expect(r2.allowed).toBe(true);
    expect(r2.tier).toBe("soft");
    await budget.reconcile("workerB", 6);
    expect(budget.tier()).toBe("soft");

    const r3 = await budget.reserve("workerC", 9);
    expect(r3.allowed).toBe(true);
    expect(r3.tier).toBe("hard");
    await budget.reconcile("workerC", 9);
    expect(budget.tier()).toBe("hard");

    expect(budget.snapshot().committedUsd).toBe(20);
  });
});

describe("hard-cap refusal", () => {
  it("refuses a reservation that would exceed the hard cap and leaves state unchanged", async () => {
    const budget = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });

    await budget.reserve("workerA", 15);
    const before = budget.snapshot();
    expect(before).toEqual({
      committedUsd: 0,
      reservedUsd: 15,
      tier: "soft",
      perWorker: { workerA: { reservedUsd: 15 } }
    });

    const rejected = await budget.reserve("workerB", 10);
    expect(rejected).toEqual({
      allowed: false,
      tier: "soft",
      committedUsd: 0,
      reservedUsd: 15
    });

    expect(budget.snapshot()).toEqual(before);
    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    expect(onDisk).toEqual({ perWorker: { workerA: { reservedUsd: 15 } } });
  });

  it("allows a reservation that lands exactly on the hard cap", async () => {
    const budget = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });

    const result = await budget.reserve("workerA", 20);
    expect(result).toEqual({ allowed: true, tier: "hard", committedUsd: 0, reservedUsd: 20 });
  });
});

describe("duplicate reservation", () => {
  it("replaces the prior reservation for the same worker instead of adding to it", async () => {
    const budget = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });

    await budget.reserve("workerA", 5);
    const r2 = await budget.reserve("workerA", 8);

    expect(r2).toEqual({ allowed: true, tier: "ok", committedUsd: 0, reservedUsd: 8 });
    expect(budget.snapshot().perWorker.workerA).toEqual({ reservedUsd: 8 });
  });
});

describe("restart roundtrip", () => {
  it("recovers committed/reserved state from disk after a restart", async () => {
    const budget1 = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });
    await budget1.reserve("workerA", 4);
    await budget1.reconcile("workerA", 4.5);
    await budget1.reserve("workerB", 2);

    const budget2 = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });
    expect(budget2.snapshot()).toEqual({
      committedUsd: 4.5,
      reservedUsd: 2,
      tier: "ok",
      perWorker: {
        workerA: { committedUsd: 4.5 },
        workerB: { reservedUsd: 2 }
      }
    });
  });
});

describe("reconcile without reservation", () => {
  it("commits the actual cost directly when there was no prior reserve", async () => {
    const budget = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });

    await budget.reconcile("workerZ", 3);

    expect(budget.snapshot()).toEqual({
      committedUsd: 3,
      reservedUsd: 0,
      tier: "ok",
      perWorker: { workerZ: { committedUsd: 3 } }
    });
  });
});

describe("rounding", () => {
  it("rounds to 6 decimals so repeated commits don't accumulate float drift", async () => {
    const budget = await createBudgetTracker({ filePath, softCapUsd: 10, hardCapUsd: 20 });

    await budget.reconcile("workerA", 0.1);
    await budget.reconcile("workerA", 0.1);
    await budget.reconcile("workerA", 0.1);

    expect(budget.snapshot().committedUsd).toBe(0.3);
  });
});

describe("concurrent persist serialization", () => {
  it("serializes concurrent reserve/reconcile persists so no on-disk entry is lost", async () => {
    const budget = await createBudgetTracker({ filePath, softCapUsd: 1000, hardCapUsd: 1000 });

    await Promise.all([
      budget.reserve("workerA", 1),
      budget.reserve("workerB", 2),
      budget.reserve("workerC", 3),
      budget.reconcile("workerD", 4),
      budget.reconcile("workerE", 5)
    ]);

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    expect(Object.keys(onDisk.perWorker).sort()).toEqual([
      "workerA",
      "workerB",
      "workerC",
      "workerD",
      "workerE"
    ]);
  });
});

describe("merge-on-write across instances", () => {
  it("does not clobber a worker entry from another tracker instance it never touched", async () => {
    const budgetA = await createBudgetTracker({ filePath, softCapUsd: 1000, hardCapUsd: 1000 });
    await budgetA.reserve("workerA", 1);

    // Simulates a second process/tracker instance pointed at the same
    // cost.json, loading a snapshot that already contains workerA.
    const budgetB = await createBudgetTracker({ filePath, softCapUsd: 1000, hardCapUsd: 1000 });

    // budgetA updates workerA again; budgetB's in-memory copy is now stale.
    await budgetA.reconcile("workerA", 9);

    // budgetB persists a change for a worker it owns; it must not clobber
    // workerA with its own stale snapshot.
    await budgetB.reserve("workerB", 2);

    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    expect(onDisk.perWorker.workerA).toEqual({ committedUsd: 9 });
    expect(onDisk.perWorker.workerB).toEqual({ reservedUsd: 2 });
  });
});
