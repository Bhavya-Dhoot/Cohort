/**
 * Runs `createOpencodeClient()` against a REAL `opencode serve` process.
 * Skipped by default (touches the actual binary + spawns a detached
 * server). Opt in with:
 *
 *   RUN_OPENCODE_IT=1 npx vitest run packages/core/test/opencode-client/client.integration.test.ts
 *
 * No prompts are sent — this only exercises spawn/ping/create/status/abort,
 * matching the "free" endpoints exercised during API discovery.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpencodeClient } from "../../src/opencode-client/client.js";
import { runGit } from "../../src/worktree/git.js";

const execFileAsync = promisify(execFile);

let root: string;
let stateDir: string;
let projectDir: string;
let serverPid: number | undefined;

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-opencode-client-it-${randomBytes(6).toString("hex")}`);
  stateDir = join(root, "state");
  projectDir = join(root, "project");
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await runGit(["init", "-b", "main"], projectDir);
  await runGit(["config", "user.email", "test@example.com"], projectDir);
  await runGit(["config", "user.name", "Test User"], projectDir);
});

afterEach(async () => {
  if (serverPid !== undefined) {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(serverPid), "/T", "/F"]).catch(() => {});
    } else {
      try {
        process.kill(serverPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    serverPid = undefined;
  }
  // Windows can hold the log file's handle open for a moment after
  // taskkill returns, so retry past a transient EBUSY on the rmdir.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe.skipIf(!process.env.RUN_OPENCODE_IT)("opencode-client integration (real opencode serve)", () => {
  it("spawns a real server, creates a session, checks status, and aborts it", async () => {
    const client = createOpencodeClient();

    const handle = await client.ensureServer({ stateDir });
    serverPid = handle.pid;
    expect(handle.spawned).toBe(true);
    expect(await client.ping(handle.baseUrl)).toBe(true);

    const session = await client.createSession(handle.baseUrl, {
      directory: projectDir,
      title: "integration-test"
    });
    expect(session.id).toMatch(/^ses/);
    expect(session.directory).toBe(projectDir);

    const status = await client.getSessionStatus(handle.baseUrl, session.id);
    expect(status.state).toBe("idle");

    await expect(client.abort(handle.baseUrl, session.id)).resolves.toBeUndefined();

    // A second ensureServer call against the same stateDir should attach to
    // the already-running process rather than spawning a second one.
    const attached = await client.ensureServer({ stateDir });
    expect(attached.spawned).toBe(false);
    expect(attached.pid).toBe(handle.pid);
  }, 30_000);
});
