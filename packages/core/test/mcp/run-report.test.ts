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

/**
 * Tests for `run_report` (the 18th tool) and the memory.yaml `sections`
 * extension seam. Self-contained copy of `mcp.test.ts`'s harness, matching
 * `pipeline.test.ts`/`review-specialist.test.ts`'s established pattern of
 * one harness copy per test file rather than a shared import.
 */

/** Path to the real shipped `config/` directory at the repo root (matches the other mcp test files). */
const PLATFORM_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../config");

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-run-report-test-${randomBytes(6).toString("hex")}`);
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

function disjointTasks() {
  return [
    { id: "task-a", title: "Task A", prompt: "implement a", dependsOn: [], fileOwnership: ["a/**"] },
    { id: "task-b", title: "Task B", prompt: "implement b", dependsOn: [], fileOwnership: ["b/**"] },
    { id: "task-c", title: "Task C", prompt: "implement c", dependsOn: [], fileOwnership: ["c/**"] }
  ];
}

// ---------------------------------------------------------------------------
// run_report
// ---------------------------------------------------------------------------

describe("run_report", () => {
  it("summarizes a run with tasks/workers/cost, writes report.md with a mermaid fence, and returns non-empty markdown", async () => {
    const client = createMockClient({ getUsage: vi.fn(async () => ({ costUsd: 1.25 })) });
    const { client: mcp, close } = await setupServer(client);
    try {
      await callTool(mcp, "plan_submit", { objective: "build the thing", tasks: disjointTasks() });
      const batchRes = await callTool(mcp, "next_batch", {});
      const taskIds = batchRes.data.tasks.map((t: { id: string }) => t.id) as string[];
      expect(taskIds.length).toBeGreaterThan(0);

      const spawned = await callTool(mcp, "spawn_worker", { taskId: taskIds[0]!, prompt: `implement ${taskIds[0]}` });
      expect(spawned.isError).toBeFalsy();
      const workerId = spawned.data.workerId as string;
      await waitForWorkerState(mcp, workerId, ["completed"]);

      const res = await callTool(mcp, "run_report", {});
      expect(res.isError).toBeFalsy();

      expect(res.data.summary.tasks.total).toBe(3);
      expect(res.data.summary.workers.total).toBe(1);
      // Free-model workers legitimately report $0; assert the field is present and non-negative.
      expect(res.data.summary.cost.committedUsd).toBeGreaterThanOrEqual(0);

      expect(typeof res.data.markdown).toBe("string");
      expect(res.data.markdown.length).toBeGreaterThan(0);
      expect(res.data.markdown).toMatch(/```mermaid/);

      const runId = await readRunId(projectDir);
      const reportPath = join(projectDir, ".agentic-os", "runs", runId, "report.md");
      expect(res.data.reportPath).toBe(reportPath);
      expect(await pathExists(reportPath)).toBe(true);

      const written = await readFile(reportPath, "utf8");
      expect(written.length).toBeGreaterThan(0);
      expect(written).toMatch(/```mermaid/);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// memory.yaml `sections` extension seam
// ---------------------------------------------------------------------------

describe("memory sections config seam", () => {
  it("a project config declaring a custom memory section can read/write it via the memory tool, while an undeclared section still errors", async () => {
    // Drives the config override dir createAgenticMcpServer already loads
    // (`<projectDir>/.agentic-os/config/memory.yaml`), matching how
    // pipeline.test.ts's writeTrivialSuiteOverride exercises the same seam
    // for orchestrator.yaml.
    await mkdir(join(projectDir, ".agentic-os", "config"), { recursive: true });
    await writeFile(
      join(projectDir, ".agentic-os", "config", "memory.yaml"),
      "sections:\n  - deployment-notes\n",
      "utf8"
    );

    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const write = await callTool(mcp, "memory", {
        action: "write",
        section: "deployment-notes",
        content: "shipped to prod on main"
      });
      expect(write.isError).toBeFalsy();

      const read = await callTool(mcp, "memory", { action: "read", section: "deployment-notes" });
      expect(read.isError).toBeFalsy();
      expect(read.data.content).toBe("shipped to prod on main");

      const undeclared = await callTool(mcp, "memory", { action: "read", section: "totally-unknown-section" });
      expect(undeclared.isError).toBe(true);
      expect(String(undeclared.data.error)).toMatch(/[Uu]nknown memory section/);
    } finally {
      await close();
    }
  });
});
