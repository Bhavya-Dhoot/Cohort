import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerSupervisor } from "../../src/worker/index.js";
import type { WorkerMeta, WorkerState, WorkerSupervisor } from "../../src/worker/index.js";
import { OpencodeTransportError } from "../../src/opencode-client/types.js";
import type { OpencodeClient, PromptResult } from "../../src/opencode-client/types.js";
import { runGit } from "../../src/worktree/index.js";

let root: string;
let repoDir: string;
let worktreesDir: string;
let stateDir: string;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-worker-test-${randomBytes(6).toString("hex")}`);
  repoDir = join(root, "repo");
  worktreesDir = join(root, "worktrees");
  stateDir = join(root, "state");
  await mkdir(repoDir, { recursive: true });

  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  // Pin line-ending handling so fixture content is byte-identical regardless
  // of the host's global core.autocrlf (Windows commonly defaults it true).
  await runGit(["config", "core.autocrlf", "false"], repoDir);

  await writeFile(join(repoDir, "README.md"), "hello\n", "utf8");
  await runGit(["add", "README.md"], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fully-stubbed OpencodeClient; pass `overrides` to replace individual methods per test. */
function createMockClient(overrides: Partial<OpencodeClient> = {}): OpencodeClient {
  const base: OpencodeClient = {
    async ensureServer() {
      return { baseUrl: "http://127.0.0.1:4096", pid: 1234, spawned: true };
    },
    async ping() {
      return true;
    },
    async createSession(_baseUrl, opts) {
      return { id: `session-${randomBytes(4).toString("hex")}`, directory: opts.directory };
    },
    async prompt(): Promise<PromptResult> {
      return { outcome: "completed", eventCount: 0 };
    },
    async abort() {
      // no-op default
    },
    async getSessionStatus() {
      return { id: "s", state: "idle" };
    },
    async getUsage() {
      return {};
    }
  };
  return { ...base, ...overrides };
}

async function waitForState(
  supervisor: WorkerSupervisor,
  workerId: string,
  states: WorkerState[],
  timeoutMs = 3000
): Promise<WorkerMeta> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = await supervisor.status(workerId);
    if (states.includes(meta.state)) {
      return meta;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for worker '${workerId}' to reach one of [${states.join(", ")}]; last state '${meta.state}'`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("happy path", () => {
  it("spawn -> completed -> verify -> verified -> finalize merge -> merged + worktree gone", async () => {
    const client = createMockClient({
      prompt: vi.fn(async (_baseUrl, _sessionId, _text, opts) => {
        opts?.onEvent?.({ ts: Date.now(), kind: "message", summary: "did the work" });
        return { outcome: "completed", eventCount: 1 };
      })
    });

    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-happy"
      // defaults.baseRef intentionally omitted: exercises resolveBaseRef's
      // git-based fallback and finalize's default-to-baseRef merge target.
    });

    const spawned = await supervisor.spawn({ taskId: "task-1", prompt: "do the thing" });
    expect(spawned.state).toBe("running");
    expect(spawned.worktreePath).toBeDefined();
    expect(spawned.baseRef).toBe("main");

    const completed = await waitForState(supervisor, spawned.workerId, ["completed"]);
    expect(completed.state).toBe("completed");
    expect(completed.usage).toBeDefined();

    // Simulate the OpenCode worker having made an uncommitted edit.
    await writeFile(join(completed.worktreePath!, "output.txt"), "hello from worker\n", "utf8");

    const collectedBefore = await supervisor.collect(spawned.workerId);
    expect(collectedBefore.filesChanged).toContain("output.txt");

    const verified = await supervisor.verify(spawned.workerId, `node -e "process.exit(0)"`);
    expect(verified.state).toBe("verified");
    expect(verified.verify?.passed).toBe(true);
    expect(verified.verify?.exitCode).toBe(0);

    const merged = await supervisor.finalize(spawned.workerId, "merge");
    expect(merged.state).toBe("merged");
    expect(merged.merge?.merged).toBe(true);
    expect(merged.merge?.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await pathExists(completed.worktreePath!)).toBe(false);

    const mergedFile = await readFile(join(repoDir, "output.txt"), "utf8");
    expect(mergedFile).toBe("hello from worker\n");
  });
});

describe("verify-fail path", () => {
  it("verification_failed then discard removes the worktree", async () => {
    const client = createMockClient();
    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-vf",
      defaults: { baseRef: "main" }
    });

    const spawned = await supervisor.spawn({ taskId: "task-2", prompt: "do the thing" });
    const completed = await waitForState(supervisor, spawned.workerId, ["completed"]);

    const failedVerify = await supervisor.verify(spawned.workerId, `node -e "process.exit(1)"`);
    expect(failedVerify.state).toBe("verification_failed");
    expect(failedVerify.verify?.passed).toBe(false);
    expect(failedVerify.lastError?.classification).toBe("logic");

    const discarded = await supervisor.finalize(spawned.workerId, "discard");
    expect(discarded.state).toBe("discarded");
    expect(await pathExists(completed.worktreePath!)).toBe(false);
  });
});

describe("timeout", () => {
  it("times out a hanging prompt and calls client.abort", async () => {
    const abortMock = vi.fn(async () => {});
    const client = createMockClient({
      prompt: vi.fn(() => new Promise<PromptResult>(() => {})), // never resolves
      abort: abortMock
    });

    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-timeout",
      defaults: { baseRef: "main", timeoutMs: 100 }
    });

    const spawned = await supervisor.spawn({ taskId: "task-3", prompt: "hang forever" });
    expect(spawned.state).toBe("running");

    const timedOut = await waitForState(supervisor, spawned.workerId, ["timeout"], 3000);
    expect(timedOut.state).toBe("timeout");
    expect(timedOut.lastError?.classification).toBe("logic");
    expect(abortMock).toHaveBeenCalledTimes(1);
  }, 10_000);
});

describe("infra retry", () => {
  it("retries infra failures with backoff and eventually reaches running", async () => {
    let attempt = 0;
    const client = createMockClient({
      createSession: vi.fn(async (_baseUrl, opts) => {
        attempt += 1;
        if (attempt <= 2) {
          throw new OpencodeTransportError("ECONNRESET");
        }
        return { id: "session-ok", directory: opts.directory };
      })
    });

    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-retry",
      defaults: { baseRef: "main", infraBackoffMs: [1, 1, 1] }
    });

    const spawned = await supervisor.spawn({ taskId: "task-4", prompt: "flaky" });
    expect(spawned.state).toBe("running");
    expect(spawned.attempts.infra).toBe(2);

    // Let the background prompt lifecycle (default mock: resolves
    // "completed") settle before the fixture tears down its tmp dir.
    await waitForState(supervisor, spawned.workerId, ["completed"]);
  });

  it("exhausts infra retries and lands on failed/infra", async () => {
    const client = createMockClient({
      createSession: vi.fn(async () => {
        throw new OpencodeTransportError("down");
      })
    });

    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-exhaust",
      defaults: { baseRef: "main", infraRetryMax: 1, infraBackoffMs: [1] }
    });

    const spawned = await supervisor.spawn({ taskId: "task-5", prompt: "always fails" });
    expect(spawned.state).toBe("failed");
    expect(spawned.lastError?.classification).toBe("infra");
  });
});

describe("reconcile", () => {
  it("marks workers crashed mid-spawn as orphaned", async () => {
    const workerId = "crashed-1";
    const crashedMeta: WorkerMeta = {
      workerId,
      runId: "run-orphan",
      taskId: "t",
      state: "session_starting",
      prompt: "p",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: { infra: 0 }
    };
    await mkdir(join(stateDir, "workers", workerId), { recursive: true });
    await writeFile(join(stateDir, "workers", workerId, "meta.json"), JSON.stringify(crashedMeta), "utf8");

    const supervisor = createWorkerSupervisor({
      client: createMockClient(),
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-orphan"
    });
    const changed = await supervisor.reconcile();

    expect(changed).toHaveLength(1);
    expect(changed[0]?.state).toBe("orphaned");

    const reloaded = await supervisor.status(workerId);
    expect(reloaded.state).toBe("orphaned");
  });

  it("marks a worker crashed while still 'created' as orphaned", async () => {
    const workerId = "crashed-created-1";
    const crashedMeta: WorkerMeta = {
      workerId,
      runId: "run-orphan-created",
      taskId: "t",
      state: "created",
      prompt: "p",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: { infra: 0 }
    };
    await mkdir(join(stateDir, "workers", workerId), { recursive: true });
    await writeFile(join(stateDir, "workers", workerId, "meta.json"), JSON.stringify(crashedMeta), "utf8");

    const supervisor = createWorkerSupervisor({
      client: createMockClient(),
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-orphan-created"
    });
    const changed = await supervisor.reconcile();

    expect(changed).toHaveLength(1);
    expect(changed[0]?.state).toBe("orphaned");

    const reloaded = await supervisor.status(workerId);
    expect(reloaded.state).toBe("orphaned");
  });

  it("flips a running worker with an idle session to completed via status()", async () => {
    const workerId = "running-1";
    const runningMeta: WorkerMeta = {
      workerId,
      runId: "run-orphan2",
      taskId: "t",
      state: "running",
      prompt: "p",
      baseUrl: "http://127.0.0.1:4096",
      sessionId: "s1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: { infra: 0 }
    };
    await mkdir(join(stateDir, "workers", workerId), { recursive: true });
    await writeFile(join(stateDir, "workers", workerId, "meta.json"), JSON.stringify(runningMeta), "utf8");

    // Fresh supervisor instance -> no in-flight promise tracked for this
    // worker, i.e. exactly the post-restart case status() must reconcile.
    const client = createMockClient({
      getSessionStatus: vi.fn(async () => ({ id: "s1", state: "idle" }))
    });
    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-orphan2"
    });

    const status = await supervisor.status(workerId);
    expect(status.state).toBe("completed");
  });
});

describe("illegal transitions", () => {
  it("throws when verifying a worker that is still running", async () => {
    const client = createMockClient({
      prompt: vi.fn(() => new Promise<PromptResult>(() => {}))
    });
    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-illegal",
      defaults: { baseRef: "main", timeoutMs: 60_000 }
    });

    const spawned = await supervisor.spawn({ taskId: "task-6", prompt: "still running" });
    expect(spawned.state).toBe("running");

    await expect(supervisor.verify(spawned.workerId, `node -e "process.exit(0)"`)).rejects.toThrow(
      /illegal from state 'running'/
    );
  });
});

describe("persistence across restart", () => {
  it("meta.json survives a fresh supervisor instance pointed at the same stateDir", async () => {
    const client = createMockClient();
    const supervisorA = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-persist",
      defaults: { baseRef: "main" }
    });

    const spawned = await supervisorA.spawn({ taskId: "task-7", prompt: "persist me" });
    await waitForState(supervisorA, spawned.workerId, ["completed"]);

    const supervisorB = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-persist"
    });
    const reloaded = await supervisorB.status(spawned.workerId);
    expect(reloaded.state).toBe("completed");
    expect(reloaded.workerId).toBe(spawned.workerId);
  });
});

describe("verify() rejection recovery", () => {
  it("reverts to 'completed' with a recorded lastError when runVerification rejects, and allows a re-verify", async () => {
    const client = createMockClient();
    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-verify-reject",
      defaults: { baseRef: "main" }
    });

    const spawned = await supervisor.spawn({ taskId: "task-verify-reject", prompt: "do the thing" });
    const completed = await waitForState(supervisor, spawned.workerId, ["completed"]);

    // Simulate the worktree disappearing out-of-band before verify runs
    // (e.g. a concurrent cleanup): the verify command's `cwd` no longer
    // exists, so the spawned process fires an 'error' event and
    // runVerification()'s promise rejects instead of resolving.
    await rm(completed.worktreePath!, { recursive: true, force: true });

    await expect(supervisor.verify(spawned.workerId, `node -e "process.exit(0)"`)).rejects.toThrow();

    const status = await supervisor.status(spawned.workerId);
    expect(status.state).toBe("completed");
    expect(status.lastError?.classification).toBe("infra");

    // Worker must not be wedged in 'verifying': a re-verify is legal again
    // (it will fail the same way since the worktree is still gone, but the
    // point is the state machine accepts the call rather than throwing
    // "illegal from state 'verifying'").
    await expect(supervisor.verify(spawned.workerId, `node -e "process.exit(0)"`)).rejects.toThrow();
  });
});

describe("abort vs status() reconciliation race", () => {
  it("keeps the aborted state when abort() interleaves with a status()-triggered reconciliation", async () => {
    const workerId = "running-race-1";
    const runningMeta: WorkerMeta = {
      workerId,
      runId: "run-race",
      taskId: "t",
      state: "running",
      prompt: "p",
      baseUrl: "http://127.0.0.1:4096",
      sessionId: "s1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: { infra: 0 }
    };
    await mkdir(join(stateDir, "workers", workerId), { recursive: true });
    await writeFile(join(stateDir, "workers", workerId, "meta.json"), JSON.stringify(runningMeta), "utf8");

    const client = createMockClient({
      // Slow enough that abort()'s persist() reliably lands on disk first.
      getSessionStatus: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { id: "s1", state: "idle" as const };
      }),
      abort: vi.fn(async () => {})
    });
    // Fresh supervisor instance -> no in-flight promise tracked for this
    // worker, i.e. exactly the post-restart case status() must reconcile.
    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-race"
    });

    const statusPromise = supervisor.status(workerId);
    // Give status() a moment to read 'running' and kick off the slow
    // getSessionStatus call before abort() runs, so the two genuinely
    // interleave instead of abort() simply winning a sequential race.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortPromise = supervisor.abort(workerId, "user requested abort");

    const [statusResult, abortResult] = await Promise.all([statusPromise, abortPromise]);
    expect(abortResult.state).toBe("aborted");
    expect(statusResult.state).toBe("aborted");

    const final = await supervisor.status(workerId);
    expect(final.state).toBe("aborted");
  });
});

describe("finalize('merge') git failure", () => {
  it("keeps state 'verified' and records lastError on an unexpected git failure instead of half-transitioning to 'merged'", async () => {
    const client = createMockClient();
    const supervisor = createWorkerSupervisor({
      client,
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-merge-fail",
      defaults: { baseRef: "main" }
    });

    const spawned = await supervisor.spawn({ taskId: "task-merge-fail", prompt: "do the thing" });
    await waitForState(supervisor, spawned.workerId, ["completed"]);
    const verified = await supervisor.verify(spawned.workerId, `node -e "process.exit(0)"`);
    expect(verified.state).toBe("verified");

    // A non-existent target branch makes mergeBranch's `git switch` fail
    // outright (not a content conflict, which mergeBranch reports normally
    // instead of throwing) — an "unexpected git failure".
    await expect(supervisor.finalize(spawned.workerId, "merge", "no-such-branch")).rejects.toThrow();

    const status = await supervisor.status(spawned.workerId);
    expect(status.state).toBe("verified");
    expect(status.lastError?.classification).toBe("infra");
    expect(status.merge).toBeUndefined();
  });
});

describe("detached HEAD", () => {
  it("fails fast at spawn() instead of poisoning the merge target with the literal 'HEAD'", async () => {
    // Detach HEAD by checking out the commit sha directly rather than the branch.
    const { stdout } = await runGit(["rev-parse", "HEAD"], repoDir);
    await runGit(["checkout", stdout.trim()], repoDir);

    const supervisor = createWorkerSupervisor({
      client: createMockClient(),
      stateDir,
      repoDir,
      worktreeBaseDir: worktreesDir,
      runId: "run-detached"
      // defaults.baseRef intentionally omitted: exercises resolveBaseRef's
      // detached-HEAD guard.
    });

    const spawned = await supervisor.spawn({ taskId: "task-detached", prompt: "should fail fast" });
    expect(spawned.state).toBe("failed");
    expect(spawned.lastError?.message).toMatch(/detached HEAD/i);
    expect(spawned.worktreePath).toBeUndefined();
  });
});
