import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerification } from "../../src/verify/index.js";

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `agentic-os-verify-test-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Polls until `pid` no longer exists (or `maxWaitMs` elapses) using the
 * standard `process.kill(pid, 0)` existence-check trick, which works on
 * both POSIX and Windows. */
async function waitUntilDead(pid: number, maxWaitMs = 3000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("runVerification", () => {
  it("reports passed for a command that exits 0", async () => {
    const result = await runVerification({
      cwd: dir,
      command: `node -e "process.exit(0)"`
    });

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("reports failed and captures stdout+stderr for a command that exits 1", async () => {
    const result = await runVerification({
      cwd: dir,
      command: `node -e "console.log('out-marker'); console.error('err-marker'); process.exit(1)"`
    });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("out-marker");
    expect(result.stderr).toContain("err-marker");
  });

  it("kills a hanging command on timeout and actually terminates the process", async () => {
    const start = Date.now();
    const result = await runVerification({
      cwd: dir,
      command: `node -e "console.log(process.pid); setInterval(()=>{},1000)"`,
      timeoutMs: 1500
    });
    const wallClockMs = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    expect(wallClockMs).toBeLessThan(10_000);

    const childPid = parseInt(result.stdout.trim(), 10);
    expect(Number.isNaN(childPid)).toBe(false);
    await expect(waitUntilDead(childPid)).resolves.toBe(true);
  }, 15_000);

  it("truncates output that exceeds maxOutputBytes", async () => {
    const result = await runVerification({
      cwd: dir,
      command: `node -e "process.stdout.write('a'.repeat(5000))"`,
      maxOutputBytes: 100
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.exitCode).toBe(0);
  });

  it("rejects when cwd does not exist", async () => {
    const missingDir = join(dir, "does-not-exist");

    await expect(
      runVerification({ cwd: missingDir, command: `node -e "process.exit(0)"` })
    ).rejects.toThrow();
  });
});
