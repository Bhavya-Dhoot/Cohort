/**
 * `cohort init` — scaffold the current project so Claude Code can drive the
 * Cohort loop in it: editable config overrides under `.cohort/config/`, the
 * `cohort` skill + reviewer subagents under `.claude/`, and a project-level
 * `.mcp.json` entry that launches the installed `cohort-mcp` server. Every
 * step is idempotent: re-running `init` must never clobber a user's edits or
 * duplicate an entry.
 */
import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "./fs-utils.mjs";

/**
 * Assets bundled inside the installed `cohort` package (see
 * scripts/copy-assets.mjs, which mirrors them here from the repo's
 * config/*.yaml and packages/plugin/{skills,agents} at build/pack time) —
 * resolved relative to this file so it works from a global npm install with
 * no dev checkout.
 */
export function defaultAssetsDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "vendor");
}

async function copyYamlDefaults(assetsDir, configDir, log) {
  await mkdir(configDir, { recursive: true });
  const files = (await readdir(join(assetsDir, "config"))).filter((f) => f.endsWith(".yaml"));
  for (const file of files) {
    const dest = join(configDir, file);
    if (await exists(dest)) {
      continue; // never clobber a user's edited override
    }
    await copyFile(join(assetsDir, "config", file), dest);
    log(`  wrote ${dest}`);
  }
}

async function copySkillAndAgents(assetsDir, projectDir, log) {
  const skillDestDir = join(projectDir, ".claude", "skills", "cohort");
  await mkdir(skillDestDir, { recursive: true });
  await copyFile(join(assetsDir, "skills", "cohort", "SKILL.md"), join(skillDestDir, "SKILL.md"));
  log(`  wrote ${join(skillDestDir, "SKILL.md")}`);

  const agentsSrcDir = join(assetsDir, "agents");
  const agentsDestDir = join(projectDir, ".claude", "agents");
  await mkdir(agentsDestDir, { recursive: true });
  // README.md documents the reviewer set (see packages/plugin/agents/README.md)
  // but isn't itself an agent definition — don't scaffold it as one.
  const agentFiles = (await readdir(agentsSrcDir)).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
  for (const file of agentFiles) {
    await copyFile(join(agentsSrcDir, file), join(agentsDestDir, file));
  }
  log(`  wrote ${agentFiles.length} reviewer agent(s) to ${agentsDestDir}`);
}

/** Merges (never replaces) the project's `.mcp.json`, setting only the `cohort` server entry. */
async function writeMcpConfig(projectDir, assetsDir, log) {
  const mcpPath = join(projectDir, ".mcp.json");
  let config = { mcpServers: {} };
  if (await exists(mcpPath)) {
    try {
      config = JSON.parse(await readFile(mcpPath, "utf8"));
    } catch {
      throw new Error(`${mcpPath} exists but is not valid JSON — fix or remove it, then re-run \`cohort init\`.`);
    }
  }
  config.mcpServers ??= {};
  config.mcpServers.cohort = {
    command: "npx",
    args: ["cohort-mcp"],
    env: { AGENTIC_CONFIG_DIR: join(assetsDir, "config") }
  };
  await writeFile(mcpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  log(`  wrote ${mcpPath}`);
}

/** Adds `entry` to the project's `.gitignore` if not already present (creates the file if missing). */
async function ensureGitignoreEntry(projectDir, entry, log) {
  const gitignorePath = join(projectDir, ".gitignore");
  let content = "";
  if (await exists(gitignorePath)) {
    content = await readFile(gitignorePath, "utf8");
  }
  const already = content.split(/\r?\n/).some((line) => line.trim().replace(/\/$/, "") === entry.replace(/\/$/, ""));
  if (already) {
    return;
  }
  const next = content.length > 0 && !content.endsWith("\n") ? `${content}\n${entry}\n` : `${content}${entry}\n`;
  await writeFile(gitignorePath, next, "utf8");
  log(`  updated ${gitignorePath} (added ${entry})`);
}

/**
 * Scaffolds `projectDir` (default: cwd). Accepts injected `projectDir` /
 * `assetsDir` / `log` for testing against a temp directory and a fixture
 * assets dir instead of the real bundled one.
 */
export async function runInit(deps = {}) {
  const projectDir = deps.projectDir ?? process.cwd();
  const assetsDir = deps.assetsDir ?? defaultAssetsDir();
  const log = deps.log ?? console.log;

  log(`Initializing Cohort in ${projectDir}...`);

  const cohortDir = join(projectDir, ".cohort");
  await mkdir(cohortDir, { recursive: true });
  await copyYamlDefaults(assetsDir, join(cohortDir, "config"), log);
  await ensureGitignoreEntry(projectDir, ".cohort/", log);
  await copySkillAndAgents(assetsDir, projectDir, log);
  await writeMcpConfig(projectDir, assetsDir, log);

  log("");
  log("Cohort initialized.");
  log('Next: cohort run "<objective>"');

  return { ok: true };
}
