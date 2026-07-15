import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveModelRoute } from "../../src/config/index.js";

/** Path to the real shipped `config/` directory at the repo root. */
const REPO_ROOT_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "../../../../config");

const FILE_NAMES = ["orchestrator", "models", "agents", "memory", "providers"] as const;
type FileName = (typeof FILE_NAMES)[number];

/** Minimal valid YAML for each file, used to build fixture config dirs. */
const MINIMAL: Record<FileName, string> = {
  orchestrator: `
budget:
  softCapUsd: 5
  hardCapUsd: 20
replan:
  maxIterations: 2
humanGates:
  planApproval: true
  preMerge: true
worker:
  maxConcurrent: 3
  timeoutMinutes: 30
  infraRetryMax: 3
worktree:
  baseDir: null
`,
  models: `
routing:
  default: "anthropic/claude-sonnet-5"
  implementation: "opencode/grok-code"
`,
  agents: `
archetypes: []
default_permission:
  deny: []
max_concurrent_specialists: 5
`,
  memory: `
store: jsonl
retention:
  decisions: project
maxContextTokensPerHandoff: 8000
summarizationModel: null
`,
  providers: `
providers:
  anthropic:
    apiKeyEnv: ANTHROPIC_API_KEY
opencode_binary_path: opencode
`
};

const tmpDirs: string[] = [];

function makeTmpDir(label: string): string {
  const dir = join(tmpdir(), `agentic-os-config-test-${label}-${randomBytes(6).toString("hex")}`);
  tmpDirs.push(dir);
  return dir;
}

async function writeConfigDir(
  dir: string,
  overrides: Partial<Record<FileName, string>> = {}
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of FILE_NAMES) {
    await writeFile(join(dir, `${name}.yaml`), overrides[name] ?? MINIMAL[name], "utf8");
  }
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("loads the real shipped config/ directory successfully", async () => {
    const config = await loadConfig(REPO_ROOT_CONFIG);

    expect(config.orchestrator.budget).toEqual({ softCapUsd: 5, hardCapUsd: 20 });
    expect(config.orchestrator.replan.maxIterations).toBe(2);
    expect(config.orchestrator.humanGates).toEqual({ planApproval: true, preMerge: true });
    expect(config.orchestrator.worker).toEqual({
      maxConcurrent: 3,
      timeoutMinutes: 30,
      infraRetryMax: 3
    });
    expect(config.orchestrator.worktree.baseDir).toBeNull();
    expect(config.models.routing.default).toBe("github-copilot/gpt-4.1");
    expect(config.agents.default_permission.deny).toContain("git push*");
    expect(config.agents.max_concurrent_specialists).toBe(5);
    expect(config.memory.store).toBe("jsonl");
    expect(config.memory.retention.decisions).toBe("project");
    expect(config.memory.maxContextTokensPerHandoff).toBe(8000);
    expect(config.memory.summarizationModel).toBeNull();
    expect(config.providers.providers.anthropic.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.providers.opencode_binary_path).toBe("opencode");
  });

  it("throws a clear error when a required default file is missing", async () => {
    const dir = makeTmpDir("missing-file");
    await mkdir(dir, { recursive: true });

    await expect(loadConfig(dir)).rejects.toThrow(/Missing required config file/);
  });

  it("deep-merges an overrides directory over the defaults", async () => {
    const defaultsDir = makeTmpDir("defaults");
    const overridesDir = makeTmpDir("overrides");
    await writeConfigDir(defaultsDir);
    await mkdir(overridesDir, { recursive: true });
    await writeFile(join(overridesDir, "orchestrator.yaml"), "budget:\n  softCapUsd: 1\n", "utf8");

    const config = await loadConfig(defaultsDir, overridesDir);

    expect(config.orchestrator.budget.softCapUsd).toBe(1); // overridden
    expect(config.orchestrator.budget.hardCapUsd).toBe(20); // retained from default
    expect(config.orchestrator.worker.maxConcurrent).toBe(3); // untouched section
    expect(config.models.routing.default).toBe("anthropic/claude-sonnet-5"); // no override file for models
  });

  it("tolerates an overrides directory missing some of the five files", async () => {
    const defaultsDir = makeTmpDir("defaults-2");
    const overridesDir = makeTmpDir("overrides-2");
    await writeConfigDir(defaultsDir);
    await mkdir(overridesDir, { recursive: true }); // empty: no override files at all

    await expect(loadConfig(defaultsDir, overridesDir)).resolves.toBeDefined();
  });

  it("interpolates ${VAR} placeholders from process.env", async () => {
    const dir = makeTmpDir("interp-set");
    await writeConfigDir(dir, {
      models: 'routing:\n  default: "${TEST_AGENTIC_OS_MODEL}"\n'
    });

    process.env.TEST_AGENTIC_OS_MODEL = "anthropic/claude-opus";
    try {
      const config = await loadConfig(dir);
      expect(config.models.routing.default).toBe("anthropic/claude-opus");
    } finally {
      delete process.env.TEST_AGENTIC_OS_MODEL;
    }
  });

  it("throws a clear error when an interpolated env var is unset", async () => {
    const dir = makeTmpDir("interp-unset");
    await writeConfigDir(dir, {
      models: 'routing:\n  default: "${TEST_AGENTIC_OS_MISSING_VAR}"\n'
    });
    delete process.env.TEST_AGENTIC_OS_MISSING_VAR;

    await expect(loadConfig(dir)).rejects.toThrow(/TEST_AGENTIC_OS_MISSING_VAR/);
  });

  it("rejects invalid config values with a useful, file-scoped error", async () => {
    const dir = makeTmpDir("invalid");
    await writeConfigDir(dir, {
      orchestrator: `
budget:
  softCapUsd: "five"
  hardCapUsd: 20
replan:
  maxIterations: 2
humanGates:
  planApproval: true
  preMerge: true
worker:
  maxConcurrent: 3
  timeoutMinutes: 30
  infraRetryMax: 3
worktree:
  baseDir: null
`
    });

    await expect(loadConfig(dir)).rejects.toThrow(/orchestrator\.yaml/);
    await expect(loadConfig(dir)).rejects.toThrow(/budget\.softCapUsd/);
  });
});

describe("resolveModelRoute", () => {
  it("resolves a known taskType to its routed model", async () => {
    const dir = makeTmpDir("routes");
    await writeConfigDir(dir);
    const config = await loadConfig(dir);

    expect(resolveModelRoute(config, "implementation")).toBe("opencode/grok-code");
  });

  it("falls back to routing.default for an unknown taskType", async () => {
    const dir = makeTmpDir("routes-unknown");
    await writeConfigDir(dir);
    const config = await loadConfig(dir);

    expect(resolveModelRoute(config, "does-not-exist")).toBe("anthropic/claude-sonnet-5");
  });

  it("falls back to routing.default when taskType is omitted", async () => {
    const dir = makeTmpDir("routes-omitted");
    await writeConfigDir(dir);
    const config = await loadConfig(dir);

    expect(resolveModelRoute(config)).toBe("anthropic/claude-sonnet-5");
  });
});
