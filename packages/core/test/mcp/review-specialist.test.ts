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
 * Tests for the two newest tools (`review_verdict`, `specialist`) and
 * `spawn_worker`'s budget soft-cap auto-downgrade. Self-contained copy of
 * `mcp.test.ts`'s harness, matching `pipeline.test.ts`'s established pattern
 * of one harness copy per test file rather than a shared import.
 */

/** Path to the real shipped `config/` directory at the repo root (matches mcp.test.ts/pipeline.test.ts). */
const PLATFORM_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../config");

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-review-specialist-test-${randomBytes(6).toString("hex")}`);
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

async function readRunEvents(forProjectDir: string): Promise<Array<Record<string, unknown>>> {
  const runId = await readRunId(forProjectDir);
  const raw = await readFile(join(forProjectDir, ".agentic-os", "runs", runId, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Writes a `.agentic-os/config/<name>.yaml` override, mirroring pipeline.test.ts's writeTrivialSuiteOverride. */
async function writeConfigOverride(forProjectDir: string, name: string, yaml: string): Promise<void> {
  await mkdir(join(forProjectDir, ".agentic-os", "config"), { recursive: true });
  await writeFile(join(forProjectDir, ".agentic-os", "config", `${name}.yaml`), yaml, "utf8");
}

// ---------------------------------------------------------------------------
// review_verdict
// ---------------------------------------------------------------------------

describe("review_verdict", () => {
  it("records a pass and a block verdict, then 'get' returns both plus a blocking summary", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const passRes = await callTool(mcp, "review_verdict", {
        action: "record",
        taskId: "task-a",
        reviewerId: "architecture",
        verdict: "pass"
      });
      expect(passRes.isError).toBeFalsy();
      expect(passRes.data).toMatchObject({ taskId: "task-a", reviewerId: "architecture", verdict: "pass" });
      expect(typeof passRes.data.path).toBe("string");

      const blockRes = await callTool(mcp, "review_verdict", {
        action: "record",
        taskId: "task-a",
        reviewerId: "security",
        verdict: "block",
        findings: [{ severity: "critical", note: "SQL injection in query builder" }]
      });
      expect(blockRes.isError).toBeFalsy();
      expect(blockRes.data).toMatchObject({ taskId: "task-a", reviewerId: "security", verdict: "block" });

      const got = await callTool(mcp, "review_verdict", { action: "get", taskId: "task-a" });
      expect(got.isError).toBeFalsy();
      expect(got.data.verdicts).toHaveLength(2);
      expect(got.data.summary).toMatchObject({ taskId: "task-a", worst: "block", blocking: true });
      expect(got.data.summary.byReviewer).toMatchObject({ architecture: "pass", security: "block" });
    } finally {
      await close();
    }
  });

  it("rejects a block/revise verdict with empty findings as a clean isError (anti-rubber-stamp)", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const revise = await callTool(mcp, "review_verdict", {
        action: "record",
        taskId: "task-a",
        reviewerId: "security",
        verdict: "revise",
        findings: []
      });
      expect(revise.isError).toBe(true);
      expect(String(revise.data.error)).toMatch(/finding/i);

      const block = await callTool(mcp, "review_verdict", {
        action: "record",
        taskId: "task-a",
        reviewerId: "security",
        verdict: "block"
      });
      expect(block.isError).toBe(true);
      expect(String(block.data.error)).toMatch(/finding/i);

      // Nothing was persisted by either rejected call.
      const got = await callTool(mcp, "review_verdict", { action: "get", taskId: "task-a" });
      expect(got.data.verdicts).toHaveLength(0);
      expect(got.data.summary.worst).toBe("none");
    } finally {
      await close();
    }
  });

  it("rejects a traversal reviewerId with a clean isError", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "review_verdict", {
        action: "record",
        taskId: "task-a",
        reviewerId: "../evil",
        verdict: "pass"
      });
      expect(res.isError).toBe(true);
      expect(typeof res.data.error).toBe("string");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// specialist
// ---------------------------------------------------------------------------

describe("specialist", () => {
  it("generate writes the agent file with the denyFloor merged in; list shows it; retire removes it", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const gen = await callTool(mcp, "specialist", {
        action: "generate",
        agentId: "oauth-engineer",
        role: "OAuth Engineer",
        description: "Handles OAuth flows",
        systemPrompt: "You are an OAuth specialist."
      });
      expect(gen.isError).toBeFalsy();
      expect(gen.data.agentId).toBe("oauth-engineer");
      expect(typeof gen.data.path).toBe("string");

      const filePath = join(projectDir, ".opencode", "agent", "oauth-engineer.md");
      expect(await pathExists(filePath)).toBe(true);
      const content = await readFile(filePath, "utf8");
      // config/agents.yaml's default_permission.deny floor must be present
      // regardless of the spec (which set no permission at all here).
      expect(content).toContain("git push*: deny");
      expect(content).toContain("npm publish*: deny");

      const listed = await callTool(mcp, "specialist", { action: "list" });
      expect(listed.isError).toBeFalsy();
      expect((listed.data.specialists as Array<{ agentId: string }>).map((s) => s.agentId)).toContain(
        "oauth-engineer"
      );

      const retired = await callTool(mcp, "specialist", { action: "retire", agentId: "oauth-engineer" });
      expect(retired.isError).toBeFalsy();
      expect(retired.data.removed).toBe(true);
      expect(await pathExists(filePath)).toBe(false);

      const listedAfter = await callTool(mcp, "specialist", { action: "list" });
      expect(listedAfter.data.specialists).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("refuses to generate beyond config.agents.max_concurrent_specialists", async () => {
    await writeConfigOverride(projectDir, "agents", "max_concurrent_specialists: 1\n");
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const first = await callTool(mcp, "specialist", {
        action: "generate",
        agentId: "spec-one",
        role: "Role One",
        description: "d",
        systemPrompt: "p"
      });
      expect(first.isError).toBeFalsy();

      const second = await callTool(mcp, "specialist", {
        action: "generate",
        agentId: "spec-two",
        role: "Role Two",
        description: "d",
        systemPrompt: "p"
      });
      expect(second.isError).toBe(true);
      expect(String(second.data.error)).toMatch(/max_concurrent_specialists/);

      const filePath = join(projectDir, ".opencode", "agent", "spec-two.md");
      expect(await pathExists(filePath)).toBe(false);
    } finally {
      await close();
    }
  });

  it("rejects a traversal agentId with a clean isError", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "specialist", {
        action: "generate",
        agentId: "../evil",
        role: "r",
        description: "d",
        systemPrompt: "p"
      });
      expect(res.isError).toBe(true);
      expect(typeof res.data.error).toBe("string");
      expect(await pathExists(join(root, "evil.md"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("enforces the cap under concurrent generate calls (TOCTOU race): with one slot remaining, exactly one of two parallel calls succeeds", async () => {
    // cap 2, 1 already live -> exactly one slot remains for the two
    // concurrent calls below.
    await writeConfigOverride(projectDir, "agents", "max_concurrent_specialists: 2\n");
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const seed = await callTool(mcp, "specialist", {
        action: "generate",
        agentId: "spec-seed",
        role: "Seed",
        description: "d",
        systemPrompt: "p"
      });
      expect(seed.isError).toBeFalsy();

      const [a, b] = await Promise.all([
        callTool(mcp, "specialist", {
          action: "generate",
          agentId: "spec-a",
          role: "Role A",
          description: "d",
          systemPrompt: "p"
        }),
        callTool(mcp, "specialist", {
          action: "generate",
          agentId: "spec-b",
          role: "Role B",
          description: "d",
          systemPrompt: "p"
        })
      ]);

      const results = [a, b];
      const succeeded = results.filter((r) => !r.isError);
      const failed = results.filter((r) => r.isError);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(String(failed[0]!.data.error)).toMatch(/max_concurrent_specialists/);

      const listed = await callTool(mcp, "specialist", { action: "list" });
      expect(listed.data.specialists).toHaveLength(2);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// spawn_worker budget soft-cap auto-downgrade
// ---------------------------------------------------------------------------

describe("spawn_worker budget soft-cap auto-downgrade", () => {
  /** Distinct, easily-distinguished routes so a downgrade is observable independent of auto:free/catalog resolution. */
  async function setupDowngradeConfig(forProjectDir: string): Promise<void> {
    await writeConfigOverride(
      forProjectDir,
      "models",
      'routing:\n  default: "provider-a/model-a"\ndowngrade_on_soft_cap: "small_model"\nsmall_model: "provider-b/model-b"\n'
    );
  }

  it("does not downgrade while the budget tier is 'ok'", async () => {
    await setupDowngradeConfig(projectDir);
    const createSessionSpy = vi.fn(async (_baseUrl: string, opts: { directory: string; model?: string }) => ({
      id: `session-${randomBytes(4).toString("hex")}`,
      directory: opts.directory
    }));
    const { client: mcp, close } = await setupServer(createMockClient({ createSession: createSessionSpy }));
    try {
      const spawned = await callTool(mcp, "spawn_worker", { taskId: "ok-tier", prompt: "do it" });
      expect(spawned.isError).toBeFalsy();
      expect(spawned.data.tier).toBe("ok");

      expect(createSessionSpy).toHaveBeenCalledTimes(1);
      expect(createSessionSpy.mock.calls[0]![1].model).toBe("provider-a/model-a");

      const events = await readRunEvents(projectDir);
      expect(events.some((e) => e.type === "model_downgraded")).toBe(false);
    } finally {
      await close();
    }
  });

  it("downgrades to config.models.small_model once the tier crosses to 'soft', and logs model_downgraded", async () => {
    await setupDowngradeConfig(projectDir);
    const createSessionSpy = vi.fn(async (_baseUrl: string, opts: { directory: string; model?: string }) => ({
      id: `session-${randomBytes(4).toString("hex")}`,
      directory: opts.directory
    }));
    const client = createMockClient({
      createSession: createSessionSpy,
      getUsage: vi.fn(async () => ({ costUsd: 6 })) // crosses shipped softCapUsd (5), stays under hardCapUsd (20)
    });
    const { client: mcp, close } = await setupServer(client);
    try {
      const spawnedA = await callTool(mcp, "spawn_worker", { taskId: "cross-a", prompt: "cross the cap" });
      expect(spawnedA.isError).toBeFalsy();
      const workerIdA = spawnedA.data.workerId as string;
      await waitForWorkerState(mcp, workerIdA, ["completed"]);

      const statusA = await callTool(mcp, "worker_status", { workerId: workerIdA });
      expect(statusA.data.budget.tier).toBe("soft");

      const spawnedB = await callTool(mcp, "spawn_worker", { taskId: "cross-b", prompt: "after the cap" });
      expect(spawnedB.isError).toBeFalsy();
      expect(spawnedB.data.tier).toBe("soft");

      expect(createSessionSpy).toHaveBeenCalledTimes(2);
      expect(createSessionSpy.mock.calls[0]![1].model).toBe("provider-a/model-a"); // worker A: spawned at 'ok'
      expect(createSessionSpy.mock.calls[1]![1].model).toBe("provider-b/model-b"); // worker B: downgraded at 'soft'

      const events = await readRunEvents(projectDir);
      const downgraded = events.filter((e) => e.type === "model_downgraded");
      expect(downgraded).toHaveLength(1);
      expect(downgraded[0]).toMatchObject({
        from: "provider-a/model-a",
        to: "provider-b/model-b",
        reason: "soft_cap"
      });
    } finally {
      await close();
    }
  });

  it("does not downgrade when the caller passes an explicit model, even at 'soft' tier", async () => {
    await setupDowngradeConfig(projectDir);
    const createSessionSpy = vi.fn(async (_baseUrl: string, opts: { directory: string; model?: string }) => ({
      id: `session-${randomBytes(4).toString("hex")}`,
      directory: opts.directory
    }));
    const client = createMockClient({
      createSession: createSessionSpy,
      getUsage: vi.fn(async () => ({ costUsd: 6 }))
    });
    const { client: mcp, close } = await setupServer(client);
    try {
      const spawnedA = await callTool(mcp, "spawn_worker", { taskId: "cross-a", prompt: "cross the cap" });
      const workerIdA = spawnedA.data.workerId as string;
      await waitForWorkerState(mcp, workerIdA, ["completed"]);
      const statusA = await callTool(mcp, "worker_status", { workerId: workerIdA });
      expect(statusA.data.budget.tier).toBe("soft");

      const spawnedB = await callTool(mcp, "spawn_worker", {
        taskId: "cross-b",
        prompt: "after the cap",
        model: "explicit/pinned-model"
      });
      expect(spawnedB.isError).toBeFalsy();

      expect(createSessionSpy.mock.calls[1]![1].model).toBe("explicit/pinned-model");
      const events = await readRunEvents(projectDir);
      expect(events.some((e) => e.type === "model_downgraded")).toBe(false);
    } finally {
      await close();
    }
  });
});
