import { describe, expect, it } from "vitest";
import { resolveSuiteName, runCheckSuite, type CheckDefinition, type RunVerificationFn } from "../../src/checks/index.js";
import type { VerifyResult } from "../../src/verify/index.js";

/** Builds a fake `VerifyResult` with sensible defaults for the fields a test doesn't care about. */
function fakeResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    passed: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    ...overrides
  };
}

/** A fake `runVerification` driven by a map of command -> result (or result factory). */
function fakeRunVerification(
  outcomes: Record<string, VerifyResult | (() => VerifyResult)>
): { fn: RunVerificationFn; calls: string[] } {
  const calls: string[] = [];
  const fn: RunVerificationFn = async (opts) => {
    calls.push(opts.command);
    const outcome = outcomes[opts.command];
    if (outcome === undefined) {
      throw new Error(`fakeRunVerification: no outcome configured for "${opts.command}"`);
    }
    return typeof outcome === "function" ? outcome() : outcome;
  };
  return { fn, calls };
}

describe("runCheckSuite", () => {
  it("reports passed:true when every check passes", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      quick: [
        { name: "typecheck", command: "npm run typecheck" },
        { name: "lint", command: "npm run lint" }
      ]
    };
    const { fn, calls } = fakeRunVerification({
      "npm run typecheck": fakeResult(),
      "npm run lint": fakeResult()
    });

    const result = await runCheckSuite({
      cwd: "/repo",
      suiteName: "quick",
      suites,
      runVerificationFn: fn
    });

    expect(result.suiteName).toBe("quick");
    expect(result.passed).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.map((c) => c.name)).toEqual(["typecheck", "lint"]);
    expect(calls).toEqual(["npm run typecheck", "npm run lint"]);
  });

  it("reports passed:false and lists failed names, and (by default) still runs the rest", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      full: [
        { name: "typecheck", command: "cmd-typecheck" },
        { name: "test", command: "cmd-test" },
        { name: "lint", command: "cmd-lint" }
      ]
    };
    const { fn, calls } = fakeRunVerification({
      "cmd-typecheck": fakeResult(),
      "cmd-test": fakeResult({ passed: false, exitCode: 1 }),
      "cmd-lint": fakeResult()
    });

    const result = await runCheckSuite({
      cwd: "/repo",
      suiteName: "full",
      suites,
      runVerificationFn: fn
    });

    expect(result.passed).toBe(false);
    expect(result.failed).toEqual(["test"]);
    // stopOnFirstFailure defaults to false: every check still ran.
    expect(calls).toEqual(["cmd-typecheck", "cmd-test", "cmd-lint"]);
    expect(result.checks).toHaveLength(3);
    expect(result.checks[1]).toMatchObject({ name: "test", passed: false, exitCode: 1 });
  });

  it("stopOnFirstFailure:true short-circuits remaining checks", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      full: [
        { name: "typecheck", command: "cmd-typecheck" },
        { name: "test", command: "cmd-test" },
        { name: "lint", command: "cmd-lint" }
      ]
    };
    const { fn, calls } = fakeRunVerification({
      "cmd-typecheck": fakeResult(),
      "cmd-test": fakeResult({ passed: false, exitCode: 1 }),
      "cmd-lint": fakeResult()
    });

    const result = await runCheckSuite({
      cwd: "/repo",
      suiteName: "full",
      suites,
      stopOnFirstFailure: true,
      runVerificationFn: fn
    });

    expect(result.passed).toBe(false);
    expect(result.failed).toEqual(["test"]);
    // "lint" never ran: not in calls, and no entry (not even a synthetic
    // not-run one) in `checks`.
    expect(calls).toEqual(["cmd-typecheck", "cmd-test"]);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.map((c) => c.name)).toEqual(["typecheck", "test"]);
  });

  it("throws a clear error listing available suite names for an unknown suite", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      quick: [{ name: "typecheck", command: "cmd" }],
      full: [{ name: "typecheck", command: "cmd" }]
    };
    const { fn } = fakeRunVerification({});

    await expect(
      runCheckSuite({ cwd: "/repo", suiteName: "regression", suites, runVerificationFn: fn })
    ).rejects.toThrow(/Unknown check suite "regression".*full, quick/s);
  });

  it("throws listing '(none configured)' when suites is empty", async () => {
    const { fn } = fakeRunVerification({});

    await expect(
      runCheckSuite({ cwd: "/repo", suiteName: "quick", suites: {}, runVerificationFn: fn })
    ).rejects.toThrow(/\(none configured\)/);
  });

  it("caps outputExcerpt to the last ~2000 chars of stdout+stderr", async () => {
    const stdout = "a".repeat(1800);
    const stderr = "b".repeat(1800);
    const suites: Record<string, CheckDefinition[]> = {
      quick: [{ name: "big-output", command: "cmd" }]
    };
    const { fn } = fakeRunVerification({
      cmd: fakeResult({ stdout, stderr })
    });

    const result = await runCheckSuite({ cwd: "/repo", suiteName: "quick", suites, runVerificationFn: fn });

    const check = result.checks[0]!;
    expect(check.outputExcerpt.length).toBe(2000);
    // It's a *tail*: the excerpt ends with the end of stderr, and starts
    // partway through stdout since stdout+stderr is 3600 chars total.
    expect(check.outputExcerpt.endsWith("b".repeat(1800))).toBe(true);
    expect(check.outputExcerpt.startsWith("a".repeat(200))).toBe(true);
  });

  it("does not truncate output under the cap", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      quick: [{ name: "small-output", command: "cmd" }]
    };
    const { fn } = fakeRunVerification({
      cmd: fakeResult({ stdout: "out-marker", stderr: "err-marker" })
    });

    const result = await runCheckSuite({ cwd: "/repo", suiteName: "quick", suites, runVerificationFn: fn });

    expect(result.checks[0]!.outputExcerpt).toBe("out-markererr-marker");
  });

  it("passes each check's configured timeoutMs through to runVerification", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      quick: [{ name: "typecheck", command: "cmd", timeoutMs: 12345 }]
    };
    let seenTimeout: number | undefined;
    const fn: RunVerificationFn = async (opts) => {
      seenTimeout = opts.timeoutMs;
      return fakeResult();
    };

    await runCheckSuite({ cwd: "/repo", suiteName: "quick", suites, runVerificationFn: fn });

    expect(seenTimeout).toBe(12345);
  });
});

describe("resolveSuiteName", () => {
  it("resolves the configured suite for a phase", () => {
    expect(resolveSuiteName({ verify: "quick", integration: "full", regression: "full" }, "verify")).toBe(
      "quick"
    );
    expect(resolveSuiteName({ verify: "quick", integration: "full", regression: "full" }, "integration")).toBe(
      "full"
    );
  });

  it("falls back when usage has no entry for the phase", () => {
    expect(resolveSuiteName({ verify: "quick" }, "regression", "full")).toBe("full");
  });

  it("falls back when usage itself is undefined", () => {
    expect(resolveSuiteName(undefined, "verify", "quick")).toBe("quick");
  });

  it("throws when neither usage nor fallback resolves the phase", () => {
    expect(() => resolveSuiteName({ verify: "quick" }, "regression")).toThrow(
      /No check suite configured for phase "regression"/
    );
  });
});
