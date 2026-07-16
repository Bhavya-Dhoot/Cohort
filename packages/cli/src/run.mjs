/**
 * `cohort run "<objective>"` — the guided one-command flow: check the
 * environment, scaffold the project if needed, then hand off to Claude
 * Code, which drives the actual orchestration loop via the `cohort` skill
 * and MCP tools. This package never re-implements that loop — it only gets
 * Claude Code running with the objective as its opening prompt. If it can't
 * verify that `claude` actually launched, it prints the exact command
 * instead of pretending the loop started.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { exists } from "./fs-utils.mjs";
import { runDoctor } from "./doctor.mjs";
import { runInit } from "./init.mjs";

/** Real handoff to Claude Code: blocks until the `claude` session exits, inheriting its stdio. */
export function defaultSpawnClaude(objective, options) {
  try {
    const result = spawnSync("claude", [objective], {
      cwd: options.cwd,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    if (result.error) {
      return { ok: false, reason: result.error.message };
    }
    return { ok: true, code: result.status ?? 0 };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function runRun(args, deps = {}) {
  const log = deps.log ?? console.log;
  const objective = (args ?? []).join(" ").trim();

  if (!objective) {
    log('Usage: cohort run "<objective>"');
    return { ok: false };
  }

  const doctorResult = await runDoctor(deps);
  if (!doctorResult.ok) {
    log("cohort run: environment check failed (see above) — fix the issues, then re-run `cohort doctor` before `cohort run`.");
    return { ok: false };
  }

  const projectDir = deps.projectDir ?? process.cwd();
  if (!(await exists(join(projectDir, ".cohort")))) {
    log("cohort run: no .cohort/ found here — running `cohort init` first...");
    await runInit({ ...deps, projectDir });
  }

  const spawnClaude = deps.spawnClaude ?? defaultSpawnClaude;
  const launched = spawnClaude(objective, { cwd: projectDir });

  if (launched.ok) {
    log("");
    log("Handed off to Claude Code — it drives the rest of the Cohort loop from here (see the `cohort` skill).");
    return { ok: true, launched: true, code: launched.code };
  }

  // Honest fallback: cohort could not verify it launched Claude Code
  // programmatically, so it prints the exact command rather than claiming
  // the loop started. This is a successful `cohort run` outcome, not a
  // crash — the environment check passed and the user has everything they
  // need to continue by hand.
  log("");
  log(`Could not launch \`claude\` programmatically (${launched.reason ?? "unknown reason"}).`);
  log("Run this yourself to start the Cohort loop:");
  log("");
  log(`  claude "${objective}"`);
  log("");
  log("(Claude Code drives the rest of the loop via the cohort skill/MCP tools once it starts.)");
  return { ok: true, launched: false };
}
