import { describe, expect, it } from "vitest";
import {
  ReviewFindingSchema,
  ReviewVerdictInputSchema,
  ReviewVerdictSchema
} from "../../src/review/schema.js";

function baseVerdict(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "t1",
    reviewerId: "security",
    verdict: "pass" as const,
    findings: [],
    at: Date.now(),
    ...overrides
  };
}

describe("ReviewFindingSchema", () => {
  it("accepts a minimal finding (severity + note only)", () => {
    const result = ReviewFindingSchema.safeParse({ severity: "minor", note: "looks fine" });
    expect(result.success).toBe(true);
  });

  it("accepts a finding with file and line", () => {
    const result = ReviewFindingSchema.safeParse({
      severity: "critical",
      file: "src/a.ts",
      line: 42,
      note: "SQL injection via unescaped input"
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid severity", () => {
    const result = ReviewFindingSchema.safeParse({ severity: "urgent", note: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty note", () => {
    const result = ReviewFindingSchema.safeParse({ severity: "nit", note: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive line number", () => {
    const result = ReviewFindingSchema.safeParse({ severity: "nit", note: "x", line: 0 });
    expect(result.success).toBe(false);
  });
});

describe("ReviewVerdictSchema anti-rubber-stamp rule", () => {
  it("rejects a 'revise' verdict with zero findings", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ verdict: "revise", findings: [] }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "findings")).toBe(true);
    }
  });

  it("rejects a 'block' verdict with zero findings", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ verdict: "block", findings: [] }));
    expect(result.success).toBe(false);
  });

  it("accepts a 'pass' verdict with zero findings", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ verdict: "pass", findings: [] }));
    expect(result.success).toBe(true);
  });

  it("accepts a 'revise' verdict that cites at least one finding", () => {
    const result = ReviewVerdictSchema.safeParse(
      baseVerdict({
        verdict: "revise",
        findings: [{ severity: "major", file: "src/a.ts", note: "missing null check" }]
      })
    );
    expect(result.success).toBe(true);
  });

  it("accepts a 'block' verdict that cites at least one finding", () => {
    const result = ReviewVerdictSchema.safeParse(
      baseVerdict({
        verdict: "block",
        findings: [{ severity: "critical", note: "hardcoded credential" }]
      })
    );
    expect(result.success).toBe(true);
  });
});

describe("ReviewVerdictSchema field shape", () => {
  it("requires taskId to match the path-safe id pattern", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ taskId: "../../etc/passwd" }));
    expect(result.success).toBe(false);
  });

  it("requires reviewerId to match the lowercase path-safe pattern", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ reviewerId: "Security" }));
    expect(result.success).toBe(false);
  });

  it("rejects a reviewerId containing a path separator", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ reviewerId: "sec/../etc" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown verdict outcome", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ verdict: "approved" }));
    expect(result.success).toBe(false);
  });

  it("requires 'at' on the full schema", () => {
    const { at, ...rest } = baseVerdict();
    const result = ReviewVerdictSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("allows 'at' to be omitted on the input schema", () => {
    const { at, ...rest } = baseVerdict();
    const result = ReviewVerdictInputSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it("summary is optional", () => {
    const result = ReviewVerdictSchema.safeParse(baseVerdict({ summary: undefined }));
    expect(result.success).toBe(true);
  });
});
