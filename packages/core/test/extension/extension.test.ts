import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgenticMcpServer, type AgenticMcpServer } from "../../src/mcp/server.js";
import { loadConfig } from "../../src/config/index.js";
import { runGit } from "../../src/worktree/index.js";
import type { OpencodeClient, PromptResult } from "../../src/opencode-client/types.js";
import type { FetchFn } from "../../src/opencode-client/http.js";

/**
 * Proves Agentic OS capability 15 -- "extend without changing core source"
 * -- for the five extension seams `mcp/server.ts` and `config/schema.ts`
 * expose: custom check suites, custom memory sections, arbitrary reviewer
 * ids, a swappable worker backend (the `OpencodeClient` DI seam), and new
 * providers. Each test below writes a project-level config override (or
 * injects a fake dependency) into a fresh scratch `projectDir`, then drives
 * the REAL tool surface (or, for providers.yaml, the real config loader --
 * there is no tool surface for providers) to prove the extension took
 * effect. No file under `packages/core/src` changes to make any of these
 * pass; see `docs/EXTENDING.md`.
 *
 * Self-contained harness copy, matching mcp.test.ts / pipeline.test.ts /
 * review-specialist.test.ts / run-report.test.ts's established convention
 * of one harness copy per test file rather than a shared import.
 */

/** Path to the real shipped `config/` directory at the repo root (matches the other mcp test files). */
const PLATFORM_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../config");

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-extension-test-${randomBytes(6).toString("hex")}`);
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

/** A `vi.fn`-wrapped fake fetch, matching mcp.test.ts's, so tests that never rely on auto:free resolution don't need a real network. */
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

/** Writes `<forProjectDir>/.agentic-os/config/<fileName>` -- the override dir `createAgenticMcpServer` already loads. */
async function writeConfigOverride(forProjectDir: string, fileName: string, yaml: string): Promise<void> {
  const dir = join(forProjectDir, ".agentic-os", "config");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), yaml, "utf8");
}

// ---------------------------------------------------------------------------
// 1. Custom check suite -- config only (orchestrator.yaml's `checks.suites`)
// ---------------------------------------------------------------------------

describe("extension point: custom check suite via orchestrator.yaml", () => {
  it("a project-declared suite runs a real trivial command through run_check_suite and passes", async () => {
    await writeConfigOverride(
      projectDir,
      "orchestrator.yaml",
      'checks:\n  suites:\n    smoke:\n      - name: echo\n        command: "node -e \\"process.exit(0)\\""\n        timeoutMs: 5000\n'
    );

    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      // No workerId/path -- runs against projectDir itself, exactly the way
      // pipeline.test.ts's "run_check_suite" describe block does.
      const res = await callTool(mcp, "run_check_suite", { suiteName: "smoke" });
      expect(res.isError).toBeFalsy();
      expect(res.data).toMatchObject({ suiteName: "smoke", passed: true });
      expect(res.data.checks).toHaveLength(1);
      expect(res.data.checks[0]).toMatchObject({ name: "echo", passed: true, exitCode: 0 });
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Custom memory section -- config only (memory.yaml's `sections`)
// ---------------------------------------------------------------------------

describe("extension point: custom memory section via memory.yaml", () => {
  it("round-trips a project-declared section through the memory tool; an undeclared section still errors", async () => {
    await writeConfigOverride(projectDir, "memory.yaml", "sections:\n  - deployment-notes\n");

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

// ---------------------------------------------------------------------------
// 3. Custom reviewer id -- no config or code change; a reviewer is a plugin
//    .md subagent definition (see docs/EXTENDING.md).
// ---------------------------------------------------------------------------

describe("extension point: arbitrary reviewer id via review_verdict", () => {
  // The reviewer *subagent* that would normally produce this verdict is a
  // plugin markdown agent file (`<projectDir>/.opencode/agent/<id>.md`,
  // same generated-agent format `specialist/index.ts` writes -- see
  // ARCHITECTURE.md's "Specialist generation" and review_verdict's own tool
  // description: "Reviewer subagents are read-only"). Adding a new reviewer
  // means adding that file and picking a reviewerId; review_verdict's
  // reviewerId is validated only for path-safety
  // (REVIEWER_ID_PATTERN, review/schema.ts) so any new id works with zero
  // change to packages/core/src, which is what this test proves at the tool
  // surface: the server has never been told "my-custom-reviewer" exists
  // anywhere, yet it works.
  it("records and reads back a verdict from a reviewer id the server has never seen before", async () => {
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const recorded = await callTool(mcp, "review_verdict", {
        action: "record",
        taskId: "task-ext",
        reviewerId: "my-custom-reviewer",
        verdict: "pass"
      });
      expect(recorded.isError).toBeFalsy();
      expect(recorded.data).toMatchObject({
        taskId: "task-ext",
        reviewerId: "my-custom-reviewer",
        verdict: "pass"
      });
      expect(typeof recorded.data.path).toBe("string");

      const got = await callTool(mcp, "review_verdict", { action: "get", taskId: "task-ext" });
      expect(got.isError).toBeFalsy();
      expect(got.data.verdicts).toHaveLength(1);
      expect(got.data.summary).toMatchObject({ taskId: "task-ext", worst: "pass", blocking: false });
      expect(got.data.summary.byReviewer).toMatchObject({ "my-custom-reviewer": "pass" });
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Alternate worker backend via DI -- the OpencodeClient interface only
// ---------------------------------------------------------------------------

describe("extension point: alternate worker backend via the OpencodeClient DI seam", () => {
  it("spawn_worker/worker_status surface values that only a third-party client implementation could have produced", async () => {
    const calls = { ensureServer: 0, createSession: 0, getUsage: 0 };
    // A from-scratch OpencodeClient implementation -- no import from, or
    // subclassing of, opencode-client/client.ts. Satisfying the interface
    // (opencode-client/types.ts) is the entire contract.
    const thirdPartyBackend: OpencodeClient = {
      async ensureServer() {
        calls.ensureServer++;
        return { baseUrl: "http://127.0.0.1:59999", pid: 999999, spawned: true };
      },
      async ping() {
        return true;
      },
      async createSession(_baseUrl, opts) {
        calls.createSession++;
        return { id: "third-party-session-001", directory: opts.directory };
      },
      async prompt() {
        return { outcome: "completed", eventCount: 1 };
      },
      async abort() {
        // no-op
      },
      async getSessionStatus() {
        return { id: "third-party-session-001", state: "idle" };
      },
      async getUsage() {
        calls.getUsage++;
        return { costUsd: 0.42 };
      }
    };

    // createAgenticMcpServer's deps.client seam (mcp/server.ts) is the
    // entire mechanism -- nothing under packages/core/src changed to accept
    // this implementation in place of the real one.
    const { client: mcp, close } = await setupServer(thirdPartyBackend);
    try {
      // Explicit model bypasses auto:free catalog resolution, so this test
      // exercises only the DI seam, not model-catalog/.
      const spawned = await callTool(mcp, "spawn_worker", {
        taskId: "task-di",
        prompt: "do the thing",
        model: "third-party/model"
      });
      expect(spawned.isError).toBeFalsy();
      // This exact session id only ever comes from thirdPartyBackend.createSession.
      expect(spawned.data.sessionId).toBe("third-party-session-001");
      expect(calls.ensureServer).toBeGreaterThanOrEqual(1);
      expect(calls.createSession).toBe(1);

      const workerId = spawned.data.workerId as string;
      const completed = await waitForWorkerState(mcp, workerId, ["completed"]);
      // This exact cost only ever comes from thirdPartyBackend.getUsage.
      expect(completed.costUsd).toBe(0.42);
      expect(calls.getUsage).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. New provider via config -- config only (providers.yaml's `providers`)
// ---------------------------------------------------------------------------

describe("extension point: new provider via providers.yaml", () => {
  it("a project-declared provider entry loads and validates through the real config loader, additively over the shipped defaults", async () => {
    await writeConfigOverride(projectDir, "providers.yaml", 'providers:\n  myllm:\n    apiKeyEnv: "MYLLM_KEY"\n');

    // providers.yaml has no dedicated tool surface (it's consumed by the
    // real opencode-client implementation, not by any MCP tool handler), so
    // the real module under test is config/index.ts's loader itself --
    // the exact loader createAgenticMcpServer calls internally.
    const overridesDir = join(projectDir, ".agentic-os", "config");
    const config = await loadConfig(PLATFORM_CONFIG_DIR, overridesDir);
    expect(config.providers.providers.myllm).toEqual({ apiKeyEnv: "MYLLM_KEY" });
    // deepMerge is additive over the shipped base, not a replace -- proof
    // this is an extension, not a fork of the defaults.
    expect(config.providers.providers.anthropic).toEqual({ apiKeyEnv: "ANTHROPIC_API_KEY" });

    // The full server also boots cleanly with this override in place --
    // providers.yaml participates in the same createAgenticMcpServer config
    // load as every other file, so a project can extend it without the
    // server refusing to start.
    const { client: mcp, close } = await setupServer(createMockClient());
    try {
      const res = await callTool(mcp, "list_workers", {});
      expect(res.isError).toBeFalsy();
    } finally {
      await close();
    }
  });
});
