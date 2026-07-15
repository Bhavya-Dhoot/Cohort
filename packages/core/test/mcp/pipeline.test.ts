import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgenticMcpServer, type AgenticMcpServer } from "../../src/mcp/server.js";
import { runGit } from "../../src/worktree/index.js";
import type { OpencodeClient, PromptResult } from "../../src/opencode-client/types.js";
import type { FetchFn } from "../../src/opencode-client/http.js";

/** Path to the real shipped `config/` directory at the repo root (matches mcp.test.ts). */
const PLATFORM_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../config");

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-pipeline-test-${randomBytes(6).toString("hex")}`);
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
// Test helpers (self-contained copies of mcp.test.ts's harness)
// ---------------------------------------------------------------------------

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

const DEFAULT_FREE_CATALOG = {
  all: [
    {
      id: "opencode",
      models: {
        "stub-free-model": {
          id: "stub-free-model",
          providerID: "opencode",
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          limit: { context: 100000 },
          release_date: "2026-01-01"
        }
      }
    }
  ],
  default: {},
  connected: ["opencode"]
};

function fakeCatalogFetch(payload: unknown = DEFAULT_FREE_CATALOG) {
  return vi.fn(async (): Promise<Response> => {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    } as Response;
  });
}

async function setupServer(
  opencodeClient: OpencodeClient,
  forProjectDir = projectDir,
  fetchFn: FetchFn = fakeCatalogFetch()
): Promise<Harness> {
  const agentic = await createAgenticMcpServer({
    projectDir: forProjectDir,
    platformConfigDir: PLATFORM_CONFIG_DIR,
    deps: { client: opencodeClient, fetchFn }
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
  let data: unknown;
  if (first?.type === "text" && first.text) {
    try {
      data = JSON.parse(first.text);
    } catch {
      data = { error: first.text };
    }
  }
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

/** Writes a `.agentic-os/config/orchestrator.yaml` override registering a trivial always-passing check suite. */
async function writeTrivialSuiteOverride(forProjectDir: string): Promise<void> {
  await mkdir(join(forProjectDir, ".agentic-os", "config"), { recursive: true });
  await writeFile(
    join(forProjectDir, ".agentic-os", "config", "orchestrator.yaml"),
    'checks:\n  suites:\n    trivial:\n      - name: noop\n        command: "node -e \\"process.exit(0)\\""\n',
    "utf8"
  );
}

function disjointTasks() {
  return [
    { id: "task-a", title: "Task A", prompt: "implement a", dependsOn: [], fileOwnership: ["a/**"] },
    { id: "task-b", title: "Task B", prompt: "implement b", dependsOn: [], fileOwnership: ["b/**"] },
    { id: "task-c", title: "Task C", prompt: "implement c", dependsOn: [], fileOwnership: ["c/**"] }
  ];
}

// ---------------------------------------------------------------------------
// plan_submit
// ---------------------------------------------------------------------------

describe("plan_submit", () => {
  it("happy path: 3 disjoint tasks land on the task board as pending", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "plan_submit", { objective: "build the thing", tasks: disjointTasks() });
      expect(res.isError).toBeFalsy();
      expect(res.data).toMatchObject({ taskCount: 3, valid: true, cycles: [], danglingDeps: [] });
      expect(res.data.planId).toBeTruthy();

      const runId = await readRunId(projectDir);
      const board = JSON.parse(
        await readFile(join(projectDir, ".agentic-os", "runs", runId, "task-board.json"), "utf8")
      );
      expect(board.tasks).toHaveLength(3);
      expect(board.tasks.every((t: { status: string }) => t.status === "pending")).toBe(true);
      expect(board.tasks.map((t: { id: string }) => t.id).sort()).toEqual(["task-a", "task-b", "task-c"]);
    } finally {
      await close();
    }
  });

  it("a dependency cycle is rejected with isError and the cycle, writing nothing", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const tasks = [
        { id: "task-a", title: "A", prompt: "a", dependsOn: ["task-b"], fileOwnership: ["a/**"] },
        { id: "task-b", title: "B", prompt: "b", dependsOn: ["task-a"], fileOwnership: ["b/**"] }
      ];
      const res = await callTool(mcp, "plan_submit", { objective: "cyclic", tasks });
      expect(res.isError).toBe(true);
      expect(res.data.valid).toBe(false);
      expect(res.data.cycles.length).toBeGreaterThan(0);

      const runId = await readRunId(projectDir);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "task-board.json"))).toBe(false);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "plan.json"))).toBe(false);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// next_batch
// ---------------------------------------------------------------------------

describe("next_batch", () => {
  it("selects all 3 disjoint tasks and marks them assigned", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      await callTool(mcp, "plan_submit", { objective: "build", tasks: disjointTasks() });
      const res = await callTool(mcp, "next_batch", {});
      expect(res.isError).toBeFalsy();
      expect(res.data.batchId).toBeTruthy();
      expect(res.data.tasks).toHaveLength(3);
      expect(res.data.tasks.every((t: { status: string }) => t.status === "assigned")).toBe(true);
      expect(res.data.blocked).toEqual([]);
    } finally {
      await close();
    }
  });

  it("reports a blocked reason when a dependency is unmet", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const tasks = [
        { id: "task-y", title: "Y", prompt: "y", dependsOn: [], fileOwnership: ["y/**"] },
        { id: "task-x", title: "X", prompt: "x", dependsOn: ["task-y"], fileOwnership: ["x/**"] }
      ];
      await callTool(mcp, "plan_submit", { objective: "build", tasks });
      const res = await callTool(mcp, "next_batch", {});
      expect(res.isError).toBeFalsy();
      expect(res.data.tasks.map((t: { id: string }) => t.id)).toEqual(["task-y"]);
      expect(res.data.blocked).toHaveLength(1);
      expect(res.data.blocked[0]).toMatchObject({ taskId: "task-x" });
      expect(res.data.blocked[0].reason).toMatch(/task-y/);
    } finally {
      await close();
    }
  });

  it("returns empty ready with a budget-hard-cap reason once the run's budget tier is 'hard'", async () => {
    const client = createMockClient({ getUsage: vi.fn(async () => ({ costUsd: 20 })) });
    const { client: mcp, close } = await setupServer(client);
    try {
      await callTool(mcp, "plan_submit", { objective: "build", tasks: disjointTasks() });

      const spawned = await callTool(mcp, "spawn_worker", { taskId: "unrelated", prompt: "expensive" });
      const workerId = spawned.data.workerId as string;
      await waitForWorkerState(mcp, workerId, ["completed"]);
      const status = await callTool(mcp, "worker_status", { workerId });
      expect(status.data.budget.tier).toBe("hard");

      const res = await callTool(mcp, "next_batch", {});
      expect(res.isError).toBeFalsy();
      expect(res.data.batchId).toBeNull();
      expect(res.data.tasks).toEqual([]);
      expect(res.data.reason).toBe("budget hard cap");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// spawn_worker: assigned-task orphan recovery
// ---------------------------------------------------------------------------

describe("spawn_worker orphan recovery", () => {
  it("reverts a task to 'pending' when its individual spawn is budget-refused, so a later next_batch re-selects it", async () => {
    const client = createMockClient({ getUsage: vi.fn(async () => ({ costUsd: 19.6 })) });
    const { client: mcp, close } = await setupServer(client);
    try {
      await callTool(mcp, "plan_submit", {
        objective: "build",
        tasks: [{ id: "task-a", title: "A", prompt: "a", dependsOn: [], fileOwnership: ["a/**"] }]
      });

      // Push committed cost to just under the hard cap ($20, shipped default)
      // with an unrelated worker, so the run's tier is 'soft' (not yet
      // 'hard') -- next_batch's own upfront tier gate lets task-a through.
      const expensive = await callTool(mcp, "spawn_worker", { taskId: "unrelated", prompt: "expensive" });
      const expensiveWorkerId = expensive.data.workerId as string;
      await waitForWorkerState(mcp, expensiveWorkerId, ["completed"]);
      const statusAfterExpensive = await callTool(mcp, "worker_status", { workerId: expensiveWorkerId });
      expect(statusAfterExpensive.data.budget.tier).not.toBe("hard");

      const batchRes = await callTool(mcp, "next_batch", {});
      expect(batchRes.data.tasks.map((t: { id: string }) => t.id)).toEqual(["task-a"]);
      expect(batchRes.data.tasks[0].status).toBe("assigned");

      // The per-task reserve() call for task-a tips committed+estimate over
      // the hard cap and is refused, even though next_batch's own upfront
      // check already let this batch through -- exactly the scenario where
      // a task can be stranded 'assigned' with no worker ever spawned.
      const spawnA = await callTool(mcp, "spawn_worker", { taskId: "task-a", prompt: "implement a" });
      expect(spawnA.isError).toBe(true);
      expect(String(spawnA.data.error)).toMatch(/[Bb]udget refused/);

      // task-a must not be stranded 'assigned' forever: a later next_batch
      // call re-selects it instead of it silently blocking forever.
      const secondBatch = await callTool(mcp, "next_batch", {});
      expect(secondBatch.data.tasks.map((t: { id: string }) => t.id)).toEqual(["task-a"]);
      expect(secondBatch.data.tasks[0].status).toBe("assigned");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: plan -> batch -> 3 workers -> verify -> integrate -> status
// ---------------------------------------------------------------------------

describe("full batch pipeline", () => {
  it("drives 3 workers to verified, integrates the batch with a passing regression suite, and reports it via batch_status", async () => {
    // More real git/worktree work than any single M1 test (3 worktrees plus
    // a throwaway regression worktree) -- the default 5s per-test timeout is
    // too tight under full-suite contention.
    await writeTrivialSuiteOverride(projectDir);
    const client = createMockClient();
    const { client: mcp, close } = await setupServer(client);
    try {
      await callTool(mcp, "plan_submit", { objective: "build", tasks: disjointTasks() });
      const batchRes = await callTool(mcp, "next_batch", {});
      const batchId = batchRes.data.batchId as string;
      const taskIds = batchRes.data.tasks.map((t: { id: string }) => t.id) as string[];
      expect(taskIds.sort()).toEqual(["task-a", "task-b", "task-c"]);

      for (const taskId of taskIds) {
        const spawned = await callTool(mcp, "spawn_worker", { taskId, prompt: `implement ${taskId}` });
        expect(spawned.isError).toBeFalsy();
        const workerId = spawned.data.workerId as string;
        const worktreePath = spawned.data.worktreePath as string;
        await waitForWorkerState(mcp, workerId, ["completed"]);

        const owned = taskId.split("-")[1]!; // task-a -> "a"
        const dir = join(worktreePath, owned);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "file.txt"), `output from ${taskId}\n`, "utf8");
        await runGit(["add", "-A"], worktreePath);
        await runGit(["commit", "-m", `${taskId} work`], worktreePath);

        const verified = await callTool(mcp, "verify_worker", { workerId, command: `node -e "process.exit(0)"` });
        expect(verified.data.state).toBe("verified");
      }

      const integrated = await callTool(mcp, "integrate_batch", { batchId, regressionSuite: "trivial" });
      expect(integrated.isError).toBeFalsy();
      expect(integrated.data.integrationBranch).toBe(`agentic/integration/${await readRunId(projectDir)}`);
      expect(integrated.data.notVerified).toEqual([]);
      expect(integrated.data.merges).toHaveLength(3);
      expect(integrated.data.merges.every((m: { outcome: string }) => m.outcome === "merged")).toBe(true);
      expect(integrated.data.allMerged).toBe(true);
      expect(integrated.data.regressionCheck).toMatchObject({ suiteName: "trivial", passed: true });
      expect(integrated.data.allPassed).toBe(true);

      // projectDir's checkout is restored to its original branch, not left on the integration branch.
      const { stdout: branch } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectDir);
      expect(branch.trim()).toBe("main");

      // Every task's file actually landed on the integration branch.
      for (const taskId of taskIds) {
        const owned = taskId.split("-")[1]!;
        const { stdout } = await runGit(["show", `${integrated.data.integrationBranch}:${owned}/file.txt`], projectDir);
        expect(stdout).toBe(`output from ${taskId}\n`);
      }

      const status = await callTool(mcp, "batch_status", { batchId });
      expect(status.isError).toBeFalsy();
      expect(status.data.status).toBe("integrated");
      expect(status.data.allTerminal).toBe(true);
      expect(status.data.integrationBranch).toBe(integrated.data.integrationBranch);
      expect(status.data.tasks).toHaveLength(3);
      for (const t of status.data.tasks) {
        expect(t.taskState).toBe("done");
        expect(t.workerState).toBe("verified");
      }
    } finally {
      await close();
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// integrate_batch: edge cases (detached HEAD, idempotency, zero-verified,
// unknown regression suite, concurrent calls for the same batch)
// ---------------------------------------------------------------------------

/** Spawns a worker for `taskId`, commits a trivial change in its worktree, and verifies it. */
async function spawnCommitVerify(mcp: Client, taskId: string): Promise<void> {
  const spawned = await callTool(mcp, "spawn_worker", { taskId, prompt: `implement ${taskId}` });
  expect(spawned.isError).toBeFalsy();
  const workerId = spawned.data.workerId as string;
  const worktreePath = spawned.data.worktreePath as string;
  await waitForWorkerState(mcp, workerId, ["completed"]);

  const owned = taskId.split("-")[1] ?? taskId;
  const dir = join(worktreePath, owned);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "file.txt"), `output from ${taskId}\n`, "utf8");
  await runGit(["add", "-A"], worktreePath);
  await runGit(["commit", "-m", `${taskId} work`], worktreePath);

  const verified = await callTool(mcp, "verify_worker", { workerId, command: `node -e "process.exit(0)"` });
  expect(verified.data.state).toBe("verified");
}

/**
 * Spawns a worker for `taskId`, creates a file in its worktree WITHOUT
 * committing it, and verifies it. Mirrors a worker that created files but
 * never ran `git commit` itself -- `verify_worker` only runs the given
 * check command against the worktree's filesystem state, so this still
 * reaches 'verified' despite the uncommitted change.
 */
async function spawnUncommittedVerify(mcp: Client, taskId: string): Promise<void> {
  const spawned = await callTool(mcp, "spawn_worker", { taskId, prompt: `implement ${taskId}` });
  expect(spawned.isError).toBeFalsy();
  const workerId = spawned.data.workerId as string;
  const worktreePath = spawned.data.worktreePath as string;
  await waitForWorkerState(mcp, workerId, ["completed"]);

  const owned = taskId.split("-")[1] ?? taskId;
  const dir = join(worktreePath, owned);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "file.txt"), `output from ${taskId}\n`, "utf8");
  // Deliberately no `git add`/`git commit` here.

  const verified = await callTool(mcp, "verify_worker", { workerId, command: `node -e "process.exit(0)"` });
  expect(verified.data.state).toBe("verified");
}

describe("integrate_batch edge cases", () => {
  it("refuses with isError on a detached-HEAD projectDir, without ever writing batch status 'integrating'", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      await callTool(mcp, "plan_submit", {
        objective: "build",
        tasks: [{ id: "task-a", title: "A", prompt: "a", dependsOn: [], fileOwnership: ["a/**"] }]
      });
      const batchRes = await callTool(mcp, "next_batch", {});
      const batchId = batchRes.data.batchId as string;
      await spawnCommitVerify(mcp, "task-a");

      const { stdout: sha } = await runGit(["rev-parse", "HEAD"], projectDir);
      await runGit(["checkout", "--detach", sha.trim()], projectDir);

      const integrated = await callTool(mcp, "integrate_batch", { batchId });
      expect(integrated.isError).toBe(true);
      expect(String(integrated.data.error)).toMatch(/detached HEAD/);

      // Never got past the fail-fast base-ref check, so status is untouched.
      const status = await callTool(mcp, "batch_status", { batchId });
      expect(status.data.status).toBe("selected");
    } finally {
      await runGit(["checkout", "main"], projectDir).catch(() => undefined);
      await close();
    }
  });

  it("is idempotent: a second call on an already-integrated batch returns cleanly without re-merging", async () => {
    await writeTrivialSuiteOverride(projectDir);
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      await callTool(mcp, "plan_submit", {
        objective: "build",
        tasks: [{ id: "task-a", title: "A", prompt: "a", dependsOn: [], fileOwnership: ["a/**"] }]
      });
      const batchRes = await callTool(mcp, "next_batch", {});
      const batchId = batchRes.data.batchId as string;
      await spawnCommitVerify(mcp, "task-a");

      const first = await callTool(mcp, "integrate_batch", { batchId, regressionSuite: "trivial" });
      expect(first.isError).toBeFalsy();
      expect(first.data.merges).toHaveLength(1);

      const second = await callTool(mcp, "integrate_batch", { batchId, regressionSuite: "trivial" });
      expect(second.isError).toBeFalsy();
      expect(second.data.merges).toEqual([]);
      expect(String(second.data.note)).toMatch(/already integrated/);
      expect(second.data.integrationBranch).toBe(first.data.integrationBranch);

      const status = await callTool(mcp, "batch_status", { batchId });
      expect(status.data.status).toBe("integrated");
    } finally {
      await close();
    }
  }, 15000);

  it("a batch with zero verified workers reports cleanly and never touches projectDir's checkout", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      await callTool(mcp, "plan_submit", {
        objective: "build",
        tasks: [{ id: "task-a", title: "A", prompt: "a", dependsOn: [], fileOwnership: ["a/**"] }]
      });
      const batchRes = await callTool(mcp, "next_batch", {});
      const batchId = batchRes.data.batchId as string;

      // Spawn but never verify -- worker stays 'completed', never 'verified'.
      const spawned = await callTool(mcp, "spawn_worker", { taskId: "task-a", prompt: "implement a" });
      await waitForWorkerState(mcp, spawned.data.workerId, ["completed"]);

      const integrated = await callTool(mcp, "integrate_batch", { batchId });
      expect(integrated.isError).toBeFalsy();
      expect(integrated.data.merges).toEqual([]);
      expect(integrated.data.notVerified).toEqual(["task-a"]);
      expect(integrated.data.allMerged).toBe(false);
      expect(integrated.data.allPassed).toBe(false);
      expect(String(integrated.data.note)).toMatch(/nothing to integrate/);

      const status = await callTool(mcp, "batch_status", { batchId });
      expect(status.data.status).toBe("failed");
      expect(status.data.integrationBranch).toBeUndefined();

      // No switch/worktree/merge was ever attempted against projectDir.
      const { stdout: branch } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectDir);
      expect(branch.trim()).toBe("main");
    } finally {
      await close();
    }
  });

  it("an unknown regressionSuite fails fast before any merge or task-status mutation", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      await callTool(mcp, "plan_submit", {
        objective: "build",
        tasks: [{ id: "task-a", title: "A", prompt: "a", dependsOn: [], fileOwnership: ["a/**"] }]
      });
      const batchRes = await callTool(mcp, "next_batch", {});
      const batchId = batchRes.data.batchId as string;
      await spawnCommitVerify(mcp, "task-a");

      const integrated = await callTool(mcp, "integrate_batch", { batchId, regressionSuite: "does-not-exist" });
      expect(integrated.isError).toBe(true);
      expect(String(integrated.data.error)).toMatch(/Unknown check suite/);

      // Nothing was mutated: batch is still 'selected', task-a is still
      // 'assigned' (never flipped to 'done'), no merge was attempted.
      const status = await callTool(mcp, "batch_status", { batchId });
      expect(status.data.status).toBe("selected");
      expect(status.data.tasks[0].taskState).toBe("assigned");

      const { stdout: branch } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectDir);
      expect(branch.trim()).toBe("main");
    } finally {
      await close();
    }
  });

  it("serializes two concurrent integrate_batch calls for the same batch: exactly one performs the real merge", async () => {
    await writeTrivialSuiteOverride(projectDir);
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      await callTool(mcp, "plan_submit", {
        objective: "build",
        tasks: [{ id: "task-a", title: "A", prompt: "a", dependsOn: [], fileOwnership: ["a/**"] }]
      });
      const batchRes = await callTool(mcp, "next_batch", {});
      const batchId = batchRes.data.batchId as string;
      await spawnCommitVerify(mcp, "task-a");

      const [a, b] = await Promise.all([
        callTool(mcp, "integrate_batch", { batchId, regressionSuite: "trivial" }),
        callTool(mcp, "integrate_batch", { batchId, regressionSuite: "trivial" })
      ]);

      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();
      const merged = [a, b].filter((r) => r.data.merges.length === 1);
      const shortCircuited = [a, b].filter((r) => r.data.merges.length === 0);
      expect(merged).toHaveLength(1);
      expect(shortCircuited).toHaveLength(1);
      expect(String(shortCircuited[0]!.data.note)).toMatch(/already integrated/);

      const status = await callTool(mcp, "batch_status", { batchId });
      expect(status.data.status).toBe("integrated");
      expect(status.data.tasks[0].taskState).toBe("done");
    } finally {
      await close();
    }
  }, 15000);

  it("auto-commits a verified worker's uncommitted worktree changes before merging, instead of silently integrating an empty diff", async () => {
    await writeTrivialSuiteOverride(projectDir);
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      await callTool(mcp, "plan_submit", {
        objective: "build",
        tasks: [{ id: "task-a", title: "A", prompt: "a", dependsOn: [], fileOwnership: ["a/**"] }]
      });
      const batchRes = await callTool(mcp, "next_batch", {});
      const batchId = batchRes.data.batchId as string;
      // Worker creates a file but never commits it -- this is the exact gap:
      // verify_worker's filesystem check still passes.
      await spawnUncommittedVerify(mcp, "task-a");

      const { stdout: baseSha } = await runGit(["rev-parse", "main"], projectDir);

      const integrated = await callTool(mcp, "integrate_batch", { batchId, regressionSuite: "trivial" });
      expect(integrated.isError).toBeFalsy();
      expect(integrated.data.merges).toHaveLength(1);
      expect(integrated.data.merges[0]).toMatchObject({ taskId: "task-a", outcome: "merged" });
      expect(integrated.data.allMerged).toBe(true);
      expect(integrated.data.allPassed).toBe(true);

      // A real, non-empty merge: the integration branch's tip is a
      // different commit than base, not a no-op merge over nothing.
      const { stdout: integrationSha } = await runGit(
        ["rev-parse", integrated.data.integrationBranch],
        projectDir
      );
      expect(integrationSha.trim()).not.toBe(baseSha.trim());

      // The uncommitted file the worker created IS present on the
      // integration branch -- proves integrate_batch auto-committed it
      // (mirroring finalize_worker's merge-path auto-commit) before merging,
      // rather than merging the worker's branch as-is with nothing on it.
      const blobRef = `${integrated.data.integrationBranch}:a/file.txt`;
      await expect(runGit(["cat-file", "-e", blobRef], projectDir)).resolves.toBeDefined();
      const { stdout: content } = await runGit(["show", blobRef], projectDir);
      expect(content).toBe("output from task-a\n");
    } finally {
      await close();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// run_check_suite
// ---------------------------------------------------------------------------

describe("run_check_suite", () => {
  it("runs a trivial passing suite against projectDir and persists the result", async () => {
    await writeTrivialSuiteOverride(projectDir);
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "run_check_suite", { suiteName: "trivial" });
      expect(res.isError).toBeFalsy();
      expect(res.data).toMatchObject({ suiteName: "trivial", passed: true });

      const runId = await readRunId(projectDir);
      expect(
        await pathExists(join(projectDir, ".agentic-os", "runs", runId, "checks", "project-trivial-1.json"))
      ).toBe(true);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// replan_record
// ---------------------------------------------------------------------------

describe("replan_record", () => {
  it("increments iterations and enforces config.orchestrator.replan.maxIterations (shipped default: 2)", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const first = await callTool(mcp, "replan_record", { reason: "worker off track", affectedTaskIds: ["task-a"] });
      expect(first.isError).toBeFalsy();
      expect(first.data).toMatchObject({ iteration: 1, escalate: false, capRemaining: 1 });

      const second = await callTool(mcp, "replan_record", { reason: "still off track", affectedTaskIds: ["task-a"] });
      expect(second.data).toMatchObject({ iteration: 2, escalate: false, capRemaining: 0 });

      const third = await callTool(mcp, "replan_record", { reason: "one more time", affectedTaskIds: ["task-a"] });
      expect(third.isError).toBeFalsy();
      expect(third.data).toMatchObject({ iteration: 3, escalate: true, capRemaining: 0 });

      const runId = await readRunId(projectDir);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "replans", "3.json"))).toBe(false);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "replans", "2.json"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("newTasks are validated and persisted, with the replan record written for them", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "replan_record", {
        reason: "add follow-up work",
        affectedTaskIds: ["task-a"],
        newTasks: [{ id: "task-new", title: "New", prompt: "new", dependsOn: [], fileOwnership: ["new/**"] }]
      });
      expect(res.isError).toBeFalsy();
      expect(res.data.newTaskIds).toEqual(["task-new"]);

      const runId = await readRunId(projectDir);
      const record = JSON.parse(
        await readFile(join(projectDir, ".agentic-os", "runs", runId, "replans", "1.json"), "utf8")
      );
      expect(record.newTaskIds).toEqual(["task-new"]);

      const board = JSON.parse(
        await readFile(join(projectDir, ".agentic-os", "runs", runId, "task-board.json"), "utf8")
      );
      expect(board.tasks.map((t: { id: string }) => t.id)).toContain("task-new");
      expect(board.tasks.find((t: { id: string }) => t.id === "task-new").status).toBe("pending");
    } finally {
      await close();
    }
  });

  it("rejects newTasks that would introduce a dependency cycle, persisting nothing", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "replan_record", {
        reason: "bad replan",
        affectedTaskIds: ["task-x"],
        newTasks: [
          { id: "task-x2", title: "X2", prompt: "x2", dependsOn: ["task-x3"], fileOwnership: ["x2/**"] },
          { id: "task-x3", title: "X3", prompt: "x3", dependsOn: ["task-x2"], fileOwnership: ["x3/**"] }
        ]
      });
      expect(res.isError).toBe(true);
      expect(res.data.valid).toBe(false);
      expect(res.data.cycles.length).toBeGreaterThan(0);

      const runId = await readRunId(projectDir);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "replans", "1.json"))).toBe(false);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "task-board.json"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("rejects newTasks with a dangling dependency, persisting nothing", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "replan_record", {
        reason: "bad replan",
        affectedTaskIds: ["task-x"],
        newTasks: [
          { id: "task-x4", title: "X4", prompt: "x4", dependsOn: ["task-missing"], fileOwnership: ["x4/**"] }
        ]
      });
      expect(res.isError).toBe(true);
      expect(res.data.valid).toBe(false);
      expect(res.data.danglingDeps.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("serializes concurrent replan_record calls into distinct, non-colliding iterations", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const [a, b] = await Promise.all([
        callTool(mcp, "replan_record", { reason: "a", affectedTaskIds: ["task-a"] }),
        callTool(mcp, "replan_record", { reason: "b", affectedTaskIds: ["task-a"] })
      ]);
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();

      const iterations = [a.data.iteration, b.data.iteration].sort((x, y) => x - y);
      expect(iterations).toEqual([1, 2]);

      const runId = await readRunId(projectDir);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "replans", "1.json"))).toBe(true);
      expect(await pathExists(join(projectDir, ".agentic-os", "runs", runId, "replans", "2.json"))).toBe(true);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

describe("memory", () => {
  it("round-trips write -> read -> append -> bundle", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const write = await callTool(mcp, "memory", { action: "write", section: "mission", content: "Build the thing." });
      expect(write.isError).toBeFalsy();

      const read = await callTool(mcp, "memory", { action: "read", section: "mission" });
      expect(read.data.content).toBe("Build the thing.");

      const append = await callTool(mcp, "memory", {
        action: "append",
        section: "decision-log",
        entry: { note: "chose approach X" }
      });
      expect(append.isError).toBeFalsy();

      const bundle = await callTool(mcp, "memory", { action: "bundle", sections: ["mission", "decision-log"], maxTokens: 2000 });
      expect(bundle.isError).toBeFalsy();
      expect(bundle.data.text).toContain("Build the thing.");
      expect(bundle.data.text).toContain("chose approach X");
      expect(bundle.data.included.sort()).toEqual(["decision-log", "mission"]);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// path traversal
// ---------------------------------------------------------------------------

describe("pipeline artifact id traversal", () => {
  it("batch_status rejects a traversal batchId", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "batch_status", { batchId: "..\\..\\evil" });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("memory rejects a traversal section name", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "memory", { action: "read", section: "../../evil" });
      expect(res.isError).toBe(true);
      expect(String(res.data.error)).toMatch(/[Uu]nknown memory section/);
    } finally {
      await close();
    }
  });
});
