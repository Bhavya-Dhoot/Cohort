import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheckSuite, type CheckDefinition } from "../../src/checks/index.js";

/**
 * Sanity check that `runCheckSuite` is actually wired to the real
 * `verify/runVerification` (no fake) — kept to 1-2 trivial commands so it
 * stays fast while proving the wiring end-to-end.
 */

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `cohort-checks-e2e-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runCheckSuite (real runVerification, no fake)", () => {
  it("passes a suite whose real commands exit 0", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      quick: [{ name: "ok", command: `node -e "process.exit(0)"` }]
    };

    const result = await runCheckSuite({ cwd: dir, suiteName: "quick", suites });

    expect(result.passed).toBe(true);
    expect(result.checks[0]).toMatchObject({ name: "ok", passed: true, exitCode: 0 });
  });

  it("fails a suite when a real command exits 1, and records it in failed[]", async () => {
    const suites: Record<string, CheckDefinition[]> = {
      full: [
        { name: "ok", command: `node -e "process.exit(0)"` },
        { name: "broken", command: `node -e "console.error('boom'); process.exit(1)"` }
      ]
    };

    const result = await runCheckSuite({ cwd: dir, suiteName: "full", suites });

    expect(result.passed).toBe(false);
    expect(result.failed).toEqual(["broken"]);
    expect(result.checks[1]).toMatchObject({ name: "broken", passed: false, exitCode: 1 });
    expect(result.checks[1]!.outputExcerpt).toContain("boom");
  });
});
