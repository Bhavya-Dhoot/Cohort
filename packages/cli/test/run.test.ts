import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRun } from "../src/run.mjs";

let base: string;
let projectDir: string;
let assetsDir: string;

const OK_EXEC_TABLE: Record<string, { ok: boolean; notFound?: boolean; stdout?: string }> = {
  "claude --version": { ok: true, stdout: "2.1.211\n" },
  "opencode --version": { ok: true, stdout: "1.15.13\n" },
  // Mirrors real `opencode auth list` output (ANSI-styled tree; see doctor.test.ts).
  "opencode auth list": { ok: true, stdout: "\x1b[34m●\x1b[39m  GitHub Copilot \x1b[90moauth\n" }
};

function okExec() {
  return async (cmd: string, args: string[]) => {
    const entry = OK_EXEC_TABLE[[cmd, ...args].join(" ")];
    return entry ? { ok: entry.ok, notFound: false, stdout: entry.stdout ?? "", stderr: "" } : { ok: false, notFound: true, stdout: "", stderr: "" };
  };
}

function failingExec() {
  return async (cmd: string) => {
    if (cmd === "claude") return { ok: false, notFound: true, stdout: "", stderr: "" };
    return okExec()(cmd, ["--version"]);
  };
}

function collectLog() {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

async function buildFixtureAssets(root: string) {
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "orchestrator.yaml"), "orchestrator: {}\n", "utf8");

  const skillDir = join(root, "skills", "cohort");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "fixture skill\n", "utf8");

  const agentsDir = join(root, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "security.md"), "fixture reviewer\n", "utf8");
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cohort-run-test-"));
  projectDir = join(base, "project");
  assetsDir = join(base, "assets");
  await mkdir(projectDir, { recursive: true });
  await buildFixtureAssets(assetsDir);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("runRun", () => {
  it("prints usage and fails when no objective is given", async () => {
    const { log, lines } = collectLog();
    const result = await runRun([], { log });
    expect(result.ok).toBe(false);
    expect(lines.some((l) => l.includes("Usage: cohort run"))).toBe(true);
  });

  it("does not attempt to launch claude when the doctor check fails", async () => {
    let spawnCalled = false;
    const spawnClaude = () => {
      spawnCalled = true;
      return { ok: true };
    };
    const { log } = collectLog();

    const result = await runRun(["fix", "the", "bug"], {
      exec: failingExec(),
      nodeVersion: "v22.17.1",
      log,
      projectDir,
      assetsDir,
      spawnClaude
    });

    expect(result.ok).toBe(false);
    expect(spawnCalled).toBe(false);
  });

  it("runs cohort init first when .cohort/ is missing, then hands off to claude", async () => {
    let spawnedWith: { objective?: string; cwd?: string } = {};
    const spawnClaude = (objective: string, options: { cwd: string }) => {
      spawnedWith = { objective, cwd: options.cwd };
      return { ok: true, code: 0 };
    };

    const result = await runRun(["build", "a", "thing"], {
      exec: okExec(),
      nodeVersion: "v22.17.1",
      log: () => {},
      projectDir,
      assetsDir,
      spawnClaude
    });

    expect(result.ok).toBe(true);
    expect(result.launched).toBe(true);
    expect(spawnedWith.objective).toBe("build a thing");
    expect(spawnedWith.cwd).toBe(projectDir);
  });

  it("does not re-run init when .cohort/ already exists", async () => {
    await mkdir(join(projectDir, ".cohort"), { recursive: true });
    const spawnClaude = () => ({ ok: true, code: 0 });

    const result = await runRun(["do", "it"], {
      exec: okExec(),
      nodeVersion: "v22.17.1",
      log: () => {},
      projectDir,
      assetsDir,
      spawnClaude
    });

    expect(result.ok).toBe(true);
    // No .mcp.json should have been written by an init we didn't need to run.
    const { exists } = await import("../src/fs-utils.mjs");
    expect(await exists(join(projectDir, ".mcp.json"))).toBe(false);
  });

  it("prints the exact claude command when it cannot verify the launch, honestly (not a crash)", async () => {
    const spawnClaude = () => ({ ok: false, reason: "ENOENT" });
    const { log, lines } = collectLog();

    const result = await runRun(["ship", "it"], {
      exec: okExec(),
      nodeVersion: "v22.17.1",
      log,
      projectDir,
      assetsDir,
      spawnClaude
    });

    expect(result.ok).toBe(true);
    expect(result.launched).toBe(false);
    expect(lines.some((l) => l.trim() === 'claude "ship it"')).toBe(true);
  });
});
