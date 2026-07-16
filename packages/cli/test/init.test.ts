import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/init.mjs";

let projectDir: string;
let assetsDir: string;

/** A minimal fixture standing in for packages/cli/vendor/ — never touches the real repo assets. */
async function buildFixtureAssets(root: string) {
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "orchestrator.yaml"), "orchestrator:\n  worker:\n    maxConcurrent: 3\n", "utf8");
  await writeFile(join(configDir, "models.yaml"), "models:\n  routing:\n    default: auto:free\n", "utf8");

  const skillDir = join(root, "skills", "cohort");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: cohort\n---\nfixture skill body\n", "utf8");

  const agentsDir = join(root, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "security.md"), "fixture security reviewer\n", "utf8");
  await writeFile(join(agentsDir, "testing.md"), "fixture testing reviewer\n", "utf8");
  await writeFile(join(agentsDir, "README.md"), "fixture docs, not an agent\n", "utf8");
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "cohort-init-test-"));
  projectDir = join(base, "project");
  assetsDir = join(base, "assets");
  await mkdir(projectDir, { recursive: true });
  await buildFixtureAssets(assetsDir);
});

afterEach(async () => {
  await rm(join(projectDir, ".."), { recursive: true, force: true });
});

describe("runInit", () => {
  it("scaffolds .cohort/config/ by copying every yaml default", async () => {
    const result = await runInit({ projectDir, assetsDir, log: () => {} });
    expect(result.ok).toBe(true);

    const orchestrator = await readFile(join(projectDir, ".cohort", "config", "orchestrator.yaml"), "utf8");
    expect(orchestrator).toContain("maxConcurrent: 3");
    const models = await readFile(join(projectDir, ".cohort", "config", "models.yaml"), "utf8");
    expect(models).toContain("auto:free");
  });

  it("writes the skill and every reviewer agent under .claude/, excluding the agents README", async () => {
    await runInit({ projectDir, assetsDir, log: () => {} });

    const skill = await readFile(join(projectDir, ".claude", "skills", "cohort", "SKILL.md"), "utf8");
    expect(skill).toContain("fixture skill body");
    const security = await readFile(join(projectDir, ".claude", "agents", "security.md"), "utf8");
    expect(security).toContain("fixture security reviewer");

    const { exists } = await import("../src/fs-utils.mjs");
    expect(await exists(join(projectDir, ".claude", "agents", "README.md"))).toBe(false);
  });

  it("writes a .mcp.json entry pointing at the installed cohort-mcp bin", async () => {
    await runInit({ projectDir, assetsDir, log: () => {} });

    const mcp = JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.cohort.command).toBe("npx");
    expect(mcp.mcpServers.cohort.args).toEqual(["cohort-mcp"]);
    expect(mcp.mcpServers.cohort.env.AGENTIC_CONFIG_DIR).toBe(join(assetsDir, "config"));
  });

  it("adds .cohort/ to .gitignore", async () => {
    await runInit({ projectDir, assetsDir, log: () => {} });
    const gitignore = await readFile(join(projectDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".cohort/");
  });

  it("preserves other existing mcpServers entries when merging .mcp.json", async () => {
    await writeFile(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-server" } } }, null, 2),
      "utf8"
    );

    await runInit({ projectDir, assetsDir, log: () => {} });

    const mcp = JSON.parse(await readFile(join(projectDir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other.command).toBe("other-server");
    expect(mcp.mcpServers.cohort.command).toBe("npx");
  });

  it("is idempotent: re-running does not clobber a user-edited config override", async () => {
    await runInit({ projectDir, assetsDir, log: () => {} });

    const overridePath = join(projectDir, ".cohort", "config", "orchestrator.yaml");
    await writeFile(overridePath, "orchestrator:\n  worker:\n    maxConcurrent: 999 # user edit\n", "utf8");

    await runInit({ projectDir, assetsDir, log: () => {} });

    const stillEdited = await readFile(overridePath, "utf8");
    expect(stillEdited).toContain("999 # user edit");
  });

  it("is idempotent: re-running does not duplicate the .gitignore entry", async () => {
    await runInit({ projectDir, assetsDir, log: () => {} });
    await runInit({ projectDir, assetsDir, log: () => {} });

    const gitignore = await readFile(join(projectDir, ".gitignore"), "utf8");
    const occurrences = gitignore.split(/\r?\n/).filter((line) => line.trim() === ".cohort/").length;
    expect(occurrences).toBe(1);
  });
});
