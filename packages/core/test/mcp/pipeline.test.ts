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
