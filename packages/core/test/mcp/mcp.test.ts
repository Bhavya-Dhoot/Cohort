import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgenticMcpServer, type AgenticMcpServer } from "../../src/mcp/server.js";
import { runGit } from "../../src/worktree/index.js";
import { openEventLog } from "../../src/events/index.js";
import type { WorkerMeta } from "../../src/worker/index.js";
import type { OpencodeClient, PromptResult } from "../../src/opencode-client/types.js";

/** Path to the real shipped `config/` directory at the repo root (M1 test fixture per the task brief). */
const PLATFORM_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../config");

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-mcp-test-${randomBytes(6).toString("hex")}`);
  projectDir = join(root, "repo");
  await mkdir(projectDir, { recursive: true });

  await runGit(["init", "-b", "main"], projectDir);
  await runGit(["config", "user.email", "test@example.com"], projectDir);
  await runGit(["config", "user.name", "Test User"], projectDir);
  await runGit(["config", "core.autocrlf", "false"], projectDir);

  await writeFile(join(projectDir, "README.md"), "hello\n", "utf8");
  await runGit(["add", "README.md"], projectDir);
  await runGit(["commit", "-m", "initial commit"], projectDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A fully-stubbed OpencodeClient; pass `overrides` to replace individual methods per test (mirrors worker.test.ts). */
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

interface Harness {
  client: Client;
  agentic: AgenticMcpServer;
  close(): Promise<void>;
}

async function setupServer(opencodeClient: OpencodeClient, forProjectDir = projectDir): Promise<Harness> {
  const agentic = await createAgenticMcpServer({
    projectDir: forProjectDir,
    platformConfigDir: PLATFORM_CONFIG_DIR,
    deps: { client: opencodeClient }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await agentic.server.connect(serverTransport);
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await mcpClient.connect(clientTransport);
  return {
    client: mcpClient,
    agentic,
    close: async () => {
      await mcpClient.close();
      await agentic.close();
    }
  };
}

interface ToolResult {
  isError: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  const data = first?.type === "text" && first.text ? JSON.parse(first.text) : undefined;
  return { isError: Boolean(result.isError), data };
}

async function waitForWorkerState(
  client: Client,
  workerId: string,
  states: string[],
  timeoutMs = 3000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await callTool(client, "worker_status", { workerId });
    if (states.includes(res.data.worker.state)) {
      return res.data.worker;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for worker '${workerId}' to reach one of [${states.join(", ")}]; last state '${res.data.worker.state}'`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readRunId(forProjectDir: string): Promise<string> {
  const raw = await readFile(join(forProjectDir, ".agentic-os", "current-run.json"), "utf8");
  return (JSON.parse(raw) as { runId: string }).runId;
}

async function readRunEvents(forProjectDir: string): Promise<Array<{ type: string; tool?: string; ok?: boolean; workerId?: string }>> {
  const runId = await readRunId(forProjectDir);
  const raw = await readFile(join(forProjectDir, ".agentic-os", "runs", runId, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("happy path over MCP", () => {
  it("spawn -> running -> completed (budget reconciled) -> verify -> finalize merge -> worktree gone; every call logged", async () => {
    let resolvePrompt!: (r: PromptResult) => void;
    const promptGate = new Promise<PromptResult>((resolve) => {
      resolvePrompt = resolve;
    });
    const client = createMockClient({
      prompt: vi.fn(async (_baseUrl, _sessionId, _text, opts) => {
        opts?.onEvent?.({ ts: Date.now(), kind: "message", summary: "did the work" });
        return promptGate;
      }),
      getUsage: vi.fn(async () => ({ costUsd: 1.25 }))
    });

    const { client: mcp, close } = await setupServer(client);
    try {
      const spawned = await callTool(mcp, "spawn_worker", { taskId: "task-1", prompt: "do the thing" });
      expect(spawned.isError).toBeFalsy();
      expect(spawned.data).toMatchObject({ state: "running", tier: "ok" });
      expect(spawned.data.workerId).toBeTruthy();
      expect(spawned.data.worktreePath).toBeTruthy();
      expect(spawned.data.sessionId).toBeTruthy();
      const workerId = spawned.data.workerId as string;
      const worktreePath = spawned.data.worktreePath as string;

      const runningStatus = await callTool(mcp, "worker_status", { workerId });
      expect(runningStatus.data.worker.state).toBe("running");

      resolvePrompt({ outcome: "completed", eventCount: 1 });
      const completed = await waitForWorkerState(mcp, workerId, ["completed"]);
      expect(completed.costUsd).toBe(1.25);

      const allStatus = await callTool(mcp, "worker_status", {});
      expect(allStatus.data.workers).toHaveLength(1);
      expect(allStatus.data.budget.committedUsd).toBe(1.25);
      expect(allStatus.data.budget.tier).toBe("ok");

      // Polling again must not double-count the same cumulative usage figure.
      await callTool(mcp, "worker_status", { workerId });
      const stillOnce = await callTool(mcp, "worker_status", {});
      expect(stillOnce.data.budget.committedUsd).toBe(1.25);

      await writeFile(join(worktreePath, "output.txt"), "hello from worker\n", "utf8");

      const verified = await callTool(mcp, "verify_worker", {
        workerId,
        command: `node -e "process.exit(0)"`
      });
      expect(verified.isError).toBeFalsy();
      expect(verified.data).toMatchObject({ state: "verified", passed: true, exitCode: 0 });

      const finalized = await callTool(mcp, "finalize_worker", { workerId, action: "merge" });
      expect(finalized.isError).toBeFalsy();
      expect(finalized.data.state).toBe("merged");
      expect(finalized.data.merged).toBe(true);
      expect(finalized.data.mergeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await pathExists(worktreePath)).toBe(false);

      const mergedFile = await readFile(join(projectDir, "output.txt"), "utf8");
      expect(mergedFile).toBe("hello from worker\n");

      // Every tool invocation above appended exactly one line to the run's event log.
      // (waitForWorkerState polls worker_status an unpredictable number of times, so
      // assert on the fixed calls' shape rather than an exact count.)
      const events = await readRunEvents(projectDir);
      const toolCalls = events.filter((e) => e.type === "tool");
      expect(toolCalls.length).toBeGreaterThanOrEqual(7); // spawn + >=4 status polls + verify + finalize
      expect(toolCalls.every((e) => typeof e.ok === "boolean")).toBe(true);
      expect(toolCalls[0]?.tool).toBe("spawn_worker");
      expect(toolCalls.slice(1, -2).every((e) => e.tool === "worker_status")).toBe(true);
      expect(toolCalls.at(-2)?.tool).toBe("verify_worker");
      expect(toolCalls.at(-1)?.tool).toBe("finalize_worker");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Budget hard cap
// ---------------------------------------------------------------------------

describe("budget hard cap", () => {
  it("refuses a spawn that would exceed the hard cap, without creating a worker dir", async () => {
    const client = createMockClient({
      prompt: vi.fn(async () => ({ outcome: "completed", eventCount: 0 })),
      getUsage: vi.fn(async () => ({ costUsd: 19.9 }))
    });
    const { client: mcp, close } = await setupServer(client);
    try {
      const spawnedA = await callTool(mcp, "spawn_worker", { taskId: "a", prompt: "expensive work" });
      expect(spawnedA.isError).toBeFalsy();
      const workerIdA = spawnedA.data.workerId as string;

      await waitForWorkerState(mcp, workerIdA, ["completed"]);
      const statusA = await callTool(mcp, "worker_status", { workerId: workerIdA });
      expect(statusA.data.budget.committedUsd).toBe(19.9);
      expect(statusA.data.budget.tier).toBe("soft");

      const runId = await readRunId(projectDir);
      const workersDir = join(projectDir, ".agentic-os", "runs", runId, "workers");
      const before = await readdir(workersDir);
      expect(before).toEqual([workerIdA]);

      const spawnedB = await callTool(mcp, "spawn_worker", { taskId: "b", prompt: "one worker too many" });
      expect(spawnedB.isError).toBe(true);
      expect(spawnedB.data.tier).toBe("soft");
      expect(spawnedB.data.committedUsd).toBe(19.9);
      expect(typeof spawnedB.data.error).toBe("string");

      const after = await readdir(workersDir);
      expect(after).toEqual(before);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// verify_worker failure
// ---------------------------------------------------------------------------

describe("verify_worker failure", () => {
  it("a failing verification command lands the worker on verification_failed", async () => {
    const client = createMockClient();
    const { client: mcp, close } = await setupServer(client);
    try {
      const spawned = await callTool(mcp, "spawn_worker", { taskId: "task-vf", prompt: "do the thing" });
      const workerId = spawned.data.workerId as string;
      await waitForWorkerState(mcp, workerId, ["completed"]);

      const verified = await callTool(mcp, "verify_worker", {
        workerId,
        command: `node -e "process.exit(1)"`
      });
      expect(verified.isError).toBeFalsy();
      expect(verified.data.state).toBe("verification_failed");
      expect(verified.data.passed).toBe(false);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// stream_worker_log
// ---------------------------------------------------------------------------

describe("stream_worker_log", () => {
  it("caps at 200 events per call and pages via nextSinceSeq", async () => {
    const client = createMockClient();
    const { client: mcp, close } = await setupServer(client);
    try {
      const workerId = "fake-worker-1";
      const runId = await readRunId(projectDir);
      const workerDir = join(projectDir, ".agentic-os", "runs", runId, "workers", workerId);
      await mkdir(workerDir, { recursive: true });

      const meta: WorkerMeta = {
        workerId,
        runId,
        taskId: "t",
        state: "running",
        prompt: "p",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: { infra: 0 }
      };
      await writeFile(join(workerDir, "meta.json"), JSON.stringify(meta), "utf8");

      const log = openEventLog(join(workerDir, "events.jsonl"));
      for (let i = 0; i < 205; i++) {
        await log.append({ type: "client_event", kind: "message", summary: `e${i}` });
      }

      const first = await callTool(mcp, "stream_worker_log", { workerId });
      expect(first.isError).toBeFalsy();
      expect(first.data.state).toBe("running");
      expect(first.data.events).toHaveLength(200);
      expect(first.data.truncated).toBe(true);
      expect(first.data.nextSinceSeq).toBe(200);

      const second = await callTool(mcp, "stream_worker_log", { workerId, sinceSeq: first.data.nextSinceSeq });
      expect(second.data.events).toHaveLength(5);
      expect(second.data.truncated).toBe(false);
      expect(second.data.nextSinceSeq).toBe(205);

      const third = await callTool(mcp, "stream_worker_log", { workerId, sinceSeq: second.data.nextSinceSeq });
      expect(third.data.events).toHaveLength(0);
      expect(third.data.nextSinceSeq).toBe(205);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// abort_worker
// ---------------------------------------------------------------------------

describe("abort_worker", () => {
  it("stops an in-flight worker", async () => {
    const abortMock = vi.fn(async () => {});
    const client = createMockClient({
      prompt: vi.fn(() => new Promise<PromptResult>(() => {})), // never resolves
      abort: abortMock
    });
    const { client: mcp, close } = await setupServer(client);
    try {
      const spawned = await callTool(mcp, "spawn_worker", { taskId: "task-abort", prompt: "hang forever" });
      const workerId = spawned.data.workerId as string;
      expect(spawned.data.state).toBe("running");

      const aborted = await callTool(mcp, "abort_worker", { workerId, reason: "off track" });
      expect(aborted.isError).toBeFalsy();
      expect(aborted.data.state).toBe("aborted");
      expect(abortMock).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// current-run.json persistence / restart reconciliation
// ---------------------------------------------------------------------------

describe("run persistence across server restarts", () => {
  it("a second server on the same projectDir reuses the run and sees the first server's workers", async () => {
    const client = createMockClient({
      prompt: vi.fn(async () => ({ outcome: "completed", eventCount: 0 }))
    });

    const first = await setupServer(client);
    const spawned = await callTool(first.client, "spawn_worker", { taskId: "persist", prompt: "persist me" });
    const workerId = spawned.data.workerId as string;
    await waitForWorkerState(first.client, workerId, ["completed"]);
    const runIdBefore = await readRunId(projectDir);
    await first.close();

    const second = await setupServer(client);
    try {
      const runIdAfter = await readRunId(projectDir);
      expect(runIdAfter).toBe(runIdBefore);

      const listed = await callTool(second.client, "list_workers", {});
      const ids = listed.data.workers.map((w: { workerId: string }) => w.workerId);
      expect(ids).toContain(workerId);
    } finally {
      await second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// unknown workerId
// ---------------------------------------------------------------------------

describe("unknown workerId", () => {
  it("worker_status returns a clean isError with the workerId and an unknown state", async () => {
    const client = createMockClient();
    const { client: mcp, close } = await setupServer(client);
    try {
      const res = await callTool(mcp, "worker_status", { workerId: "does-not-exist" });
      expect(res.isError).toBe(true);
      expect(res.data.workerId).toBe("does-not-exist");
      expect(res.data.state).toBe("unknown");
      expect(typeof res.data.error).toBe("string");
    } finally {
      await close();
    }
  });

  it("stream_worker_log returns a clean isError for an unknown worker", async () => {
    const client = createMockClient();
    const { client: mcp, close } = await setupServer(client);
    try {
      const res = await callTool(mcp, "stream_worker_log", { workerId: "does-not-exist" });
      expect(res.isError).toBe(true);
      expect(res.data.workerId).toBe("does-not-exist");
      expect(res.data.state).toBe("unknown");
    } finally {
      await close();
    }
  });

  it("finalize_worker returns a clean isError for an unknown worker", async () => {
    const client = createMockClient();
    const { client: mcp, close } = await setupServer(client);
    try {
      const res = await callTool(mcp, "finalize_worker", { workerId: "does-not-exist", action: "discard" });
      expect(res.isError).toBe(true);
      expect(res.data.workerId).toBe("does-not-exist");
    } finally {
      await close();
    }
  });
});
