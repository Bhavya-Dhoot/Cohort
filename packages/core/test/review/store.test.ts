import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReviewStore, type ReviewVerdictInput } from "../../src/review/index.js";

let runDir: string;

function verdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    taskId: "t1",
    reviewerId: "security",
    verdict: "pass",
    findings: [],
    ...overrides
  };
}

beforeEach(() => {
  runDir = join(tmpdir(), `agentic-os-review-test-${randomBytes(6).toString("hex")}`);
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

describe("recordVerdict", () => {
  it("writes to reviews/<taskId>/<reviewerId>-0.json on the first call", async () => {
    const store = openReviewStore(runDir);
    const result = await store.recordVerdict(verdict());
    expect(result).toMatchObject({ taskId: "t1", reviewerId: "security" });
    expect(result.path.replace(/\\/g, "/")).toMatch(/reviews\/t1\/security-0\.json$/);
  });

  it("versions a second verdict for the same task+reviewer as -1, without overwriting -0", async () => {
    const store = openReviewStore(runDir);
    const first = await store.recordVerdict(verdict({ at: 1000 }));
    const second = await store.recordVerdict(verdict({ at: 2000 }));

    expect(first.path.replace(/\\/g, "/")).toMatch(/security-0\.json$/);
    expect(second.path.replace(/\\/g, "/")).toMatch(/security-1\.json$/);

    const all = await store.getVerdicts("t1", "security");
    expect(all).toHaveLength(2);
    expect(all.map((v) => v.at).sort()).toEqual([1000, 2000]);
  });

  it("stamps 'at' with the current time when omitted", async () => {
    const store = openReviewStore(runDir);
    const before = Date.now();
    await store.recordVerdict(verdict());
    const after = Date.now();

    const [stored] = await store.getVerdicts("t1");
    expect(stored!.at).toBeGreaterThanOrEqual(before);
    expect(stored!.at).toBeLessThanOrEqual(after);
  });

  it("rejects a 'revise' verdict with no findings before writing anything", async () => {
    const store = openReviewStore(runDir);
    await expect(
      store.recordVerdict(verdict({ verdict: "revise", findings: [] }))
    ).rejects.toThrow(/at least one finding/);
    expect(await store.getVerdicts("t1")).toEqual([]);
  });

  it("rejects an invalid taskId (traversal) before touching disk", async () => {
    const store = openReviewStore(runDir);
    await expect(
      store.recordVerdict(verdict({ taskId: "../../etc" }))
    ).rejects.toThrow();
  });

  it("rejects an invalid reviewerId (traversal)", async () => {
    const store = openReviewStore(runDir);
    await expect(
      store.recordVerdict(verdict({ reviewerId: "../etc" }))
    ).rejects.toThrow();
  });
});

describe("getVerdicts", () => {
  it("returns verdicts for a task newest-first by 'at'", async () => {
    const store = openReviewStore(runDir);
    await store.recordVerdict(verdict({ at: 1000 }));
    await store.recordVerdict(verdict({ at: 3000 }));
    await store.recordVerdict(verdict({ at: 2000 }));

    const all = await store.getVerdicts("t1");
    expect(all.map((v) => v.at)).toEqual([3000, 2000, 1000]);
  });

  it("filters to a single reviewerId when given", async () => {
    const store = openReviewStore(runDir);
    await store.recordVerdict(verdict({ reviewerId: "security", at: 1000 }));
    await store.recordVerdict(verdict({ reviewerId: "architecture", at: 2000 }));

    const securityOnly = await store.getVerdicts("t1", "security");
    expect(securityOnly).toHaveLength(1);
    expect(securityOnly[0]!.reviewerId).toBe("security");
  });

  it("returns [] for a task with no recorded verdicts", async () => {
    const store = openReviewStore(runDir);
    expect(await store.getVerdicts("unknown-task")).toEqual([]);
  });

  it("rejects an invalid taskId (traversal)", async () => {
    const store = openReviewStore(runDir);
    await expect(store.getVerdicts("../etc")).rejects.toThrow();
  });

  it("rejects an invalid reviewerId (traversal)", async () => {
    const store = openReviewStore(runDir);
    await expect(store.getVerdicts("t1", "../etc")).rejects.toThrow();
  });
});

describe("summarizeTask", () => {
  it("reports worst='none' and blocking=false when no verdicts exist", async () => {
    const store = openReviewStore(runDir);
    const summary = await store.summarizeTask("t1");
    expect(summary).toEqual({ taskId: "t1", worst: "none", byReviewer: {}, blocking: false });
  });

  it("worst is 'pass' and blocking=false when every reviewer's latest verdict passes", async () => {
    const store = openReviewStore(runDir);
    await store.recordVerdict(verdict({ reviewerId: "security", verdict: "pass", at: 1000 }));
    await store.recordVerdict(verdict({ reviewerId: "architecture", verdict: "pass", at: 1000 }));

    const summary = await store.summarizeTask("t1");
    expect(summary.worst).toBe("pass");
    expect(summary.blocking).toBe(false);
    expect(summary.byReviewer).toEqual({ security: "pass", architecture: "pass" });
  });

  it("block wins over revise and pass across reviewers", async () => {
    const store = openReviewStore(runDir);
    await store.recordVerdict(verdict({ reviewerId: "security", verdict: "pass", at: 1000 }));
    await store.recordVerdict(
      verdict({
        reviewerId: "architecture",
        verdict: "revise",
        findings: [{ severity: "major", note: "tighten coupling" }],
        at: 1000
      })
    );
    await store.recordVerdict(
      verdict({
        reviewerId: "performance",
        verdict: "block",
        findings: [{ severity: "critical", note: "N+1 query" }],
        at: 1000
      })
    );

    const summary = await store.summarizeTask("t1");
    expect(summary.worst).toBe("block");
    expect(summary.blocking).toBe(true);
  });

  it("a latest 'revise' blocks even with no 'block' verdicts", async () => {
    const store = openReviewStore(runDir);
    await store.recordVerdict(verdict({ reviewerId: "security", verdict: "pass", at: 1000 }));
    await store.recordVerdict(
      verdict({
        reviewerId: "architecture",
        verdict: "revise",
        findings: [{ severity: "minor", note: "naming" }],
        at: 1000
      })
    );

    const summary = await store.summarizeTask("t1");
    expect(summary.worst).toBe("revise");
    expect(summary.blocking).toBe(true);
  });

  it("uses only the latest verdict per reviewer -- an earlier block cleared by a later pass is not blocking", async () => {
    const store = openReviewStore(runDir);
    await store.recordVerdict(
      verdict({
        reviewerId: "security",
        verdict: "block",
        findings: [{ severity: "critical", note: "hardcoded secret" }],
        at: 1000
      })
    );
    await store.recordVerdict(verdict({ reviewerId: "security", verdict: "pass", at: 2000 }));

    const summary = await store.summarizeTask("t1");
    expect(summary.byReviewer).toEqual({ security: "pass" });
    expect(summary.worst).toBe("pass");
    expect(summary.blocking).toBe(false);
  });

  it("rejects an invalid taskId (traversal)", async () => {
    const store = openReviewStore(runDir);
    await expect(store.summarizeTask("../etc")).rejects.toThrow();
  });
});

describe("concurrency", () => {
  it("10 concurrent recordVerdict calls for the same task+reviewer yield 10 distinct, gap-free versions", async () => {
    const store = openReviewStore(runDir);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.recordVerdict(verdict({ at: i })))
    );

    const indices = results
      .map((r) => Number(/-(\d+)\.json$/.exec(r.path)?.[1]))
      .sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => i));

    const all = await store.getVerdicts("t1", "security");
    expect(all).toHaveLength(10);
    expect(new Set(all.map((v) => v.at)).size).toBe(10); // none lost or overwritten
  });

  it("concurrent calls across different task+reviewer keys don't interfere", async () => {
    const store = openReviewStore(runDir);

    await Promise.all([
      store.recordVerdict(verdict({ taskId: "t1", reviewerId: "security" })),
      store.recordVerdict(verdict({ taskId: "t1", reviewerId: "architecture" })),
      store.recordVerdict(verdict({ taskId: "t2", reviewerId: "security" }))
    ]);

    expect(await store.getVerdicts("t1")).toHaveLength(2);
    expect(await store.getVerdicts("t2")).toHaveLength(1);
  });
});
