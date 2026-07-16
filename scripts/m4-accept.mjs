#!/usr/bin/env node
/**
 * scripts/m4-accept.mjs — M4 acceptance test for Agentic OS.
 *
 * Proves two things end-to-end with a REAL OpenCode worker on a free model,
 * driven entirely through the real MCP tool surface: (1) a project can add a
 * custom check suite via a partial `.agentic-os/config/orchestrator.yaml`
 * override with zero code changes, and that suite actually runs live through
 * `run_check_suite`; (2) `run_report` renders a correct observability report
 * (structured summary + markdown with both mermaid diagrams) from real
 * on-disk run artifacts, and persists it to `<runDir>/report.md`.
 *
 * Deliberately small: plan_submit -> next_batch -> spawn_worker x1 ->
 * worker_status polling -> collect_worker/verify_worker -> run_check_suite
 * (custom 'smoke' suite) -> integrate_batch -> run_report. This is not
 * re-proving the M2/M3 pipeline machinery (DAG batching, org/specialists,
 * reviewer verdicts) -- those are already covered by m2-accept.mjs and
 * m3-accept.mjs. One task is enough to exercise every M4-specific surface.
 *
 * Structurally a sibling of scripts/m3-accept.mjs (same build-then-
 * scratch-repo-then-MCP-client shape, same poll pattern, same Windows
 * post-merge worktree-handle race handling, same "keep the scratch dir on
 * failure" diagnostics contract).
 *
 * Usage: npm run m4-accept
 * Env:   M4_SCRATCH_DIR  optional override for the scratch repo/worktrees
 *                          root; defaults under os.tmpdir() (see
 *                          smoke.mjs's SMOKE_SCRATCH_DIR doc for why: a
 *                          scratch git repo/worktrees must never nest inside
 *                          this platform repo itself).
 *
 * Notes verified against source, not assumed:
 *   - config/index.ts's `loadFile` deep-merges a project override YAML over
 *     the shipped default (objects merge key-by-key recursively, arrays and
 *     scalars replace outright) before schema validation -- so a project
 *     override containing ONLY a `checks` key is enough: `budget`, `replan`,
 *     `humanGates`, `worker`, and `worktree` still come from the shipped
 *     config/orchestrator.yaml untouched, and `checks.suites` gets the new
 *     `smoke` suite merged in alongside the shipped `quick`/`full` ones
 *     (rather than replacing them). This script uses that partial-override
 *     form, not a full copy of the shipped file.
 *   - `createAgenticMcpServer` (mcp/server.ts) only applies a project
 *     override if `<projectDir>/.agentic-os/config` exists at server-start
 *     time (`directoryExists(overridesDir)` gates `loadConfig`'s second
 *     arg) -- so the override file below is written before the server is
 *     created, not after.
 *   - `run_check_suite`'s inputSchema is flat (`workerId?`, `path?`,
 *     `suiteName`), not a nested `scope` object -- omitting both `workerId`
 *     and `path` runs the suite against `projectDir` itself (server.ts's
 *     `runCheckSuiteHandler`), which is exactly the scratch repo the
 *     override config lives in.
 *   - `run_report`'s inputSchema is `{}` (no args) and its handler
 *     (`runReportHandler`) calls `generateRunReport(ctx.runDir)`, writes the
 *     markdown to `<runDir>/report.md` via `atomicWriteText`, and returns
 *     `{summary, reportPath, markdown}` -- `report/index.ts` confirms the
 *     markdown always contains a ```mermaid gantt block ("Execution
 *     Timeline") and a ```mermaid graph TD block ("Task DAG") whenever at
 *     least one worker/task exists, plus a "## Model & Cost Usage" section
 *     with a per-worker table.
 *   - config/models.yaml's routing.default is already "auto:free" -- no
 *     explicit `model` is passed to spawn_worker.
 *   - No in-script retry-with-different-model loop is implemented, per
 *     ORCHESTRATION.md's "root-cause before retrying" doctrine (same stance
 *     m2-accept.mjs/m3-accept.mjs document) -- on a model-caused failure
 *     this script fails fast with full diagnostics.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLATFORM_CONFIG_DIR = path.join(REPO_ROOT, "config");
const SCRATCH_BASE_DIR = process.env.M4_SCRATCH_DIR ?? path.join(os.tmpdir(), "agentic-m4-accept");

const POLL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const REGRESSION_SUITE = "full"; // config/orchestrator.yaml checks.suites.full = typecheck + test
const CUSTOM_SUITE = "smoke"; // added live via the project's orchestrator.yaml override below
const CUSTOM_CHECK_NAME = "exists";

const FAILURE_STATES = new Set(["failed", "timeout", "aborted", "orphaned", "verification_failed"]);
const IN_FLIGHT_STATES = new Set([
  "created",
  "worktree_provisioning",
  "worktree_ready",
  "session_starting",
  "running",
  "verifying"
]);
const STUCK_POLLS = 6; // 30s

// Single disjoint task -- enough to prove the DAG/batch/worker machinery is
// still intact while keeping the focus on what's new in M4 (custom check
// override + run_report).
const TASK = {
  id: "feat-x",
  title: "Add src/x.js",
  file: "src/x.js",
  fileOwnership: ["src/x.js"],
  prompt:
    "Create src/x.js exporting a function x() that returns 42. Only create that file. " +
    "Then run `git add src/x.js` and `git commit -m \"add: src/x.js\"` to commit it."
};

// Populated as soon as known, so fail()/dumpDiagnostics() can use whatever
// is available at the point of failure.
let scratchRoot;
let repoDir;
let runId;
let mcpClient;
let agenticServer;
/** taskId -> { workerId, verifyCommand, file, lastState, unchangedPolls, sinceSeq, processed, failed } */
const workers = new Map();

function log(...args) {
  console.log(`[m4-accept ${new Date().toISOString()}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, cwd, opts = {}) {
  const { allowFail, ...spawnOpts } = opts;
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", ...spawnOpts });
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}\n` +
        `--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`
    );
  }
  return result;
}

function git(args, cwd, opts) {
  return run("git", args, cwd, opts);
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function tailFile(filePath, maxChars = 4000) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.length > maxChars ? `...(truncated)...\n${content.slice(-maxChars)}` : content;
  } catch (err) {
    return `<could not read ${filePath}: ${err.message}>`;
  }
}

function runDirFor(repo, id) {
  return path.join(repo, ".agentic-os", "runs", id);
}

function workerMetaPath(workerId) {
  return path.join(runDirFor(repoDir, runId), "workers", workerId, "meta.json");
}

async function readWorkerMetaJson(workerId) {
  try {
    return JSON.parse(await readFile(workerMetaPath(workerId), "utf8"));
  } catch {
    return {};
  }
}

async function callTool(name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  const content = result.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  let data;
  if (first?.type === "text" && first.text) {
    try {
      data = JSON.parse(first.text);
    } catch {
      data = { error: first.text };
    }
  }
  return { isError: Boolean(result.isError), data };
}

async function dumpDiagnostics() {
  console.error("\n[m4-accept] ---- diagnostics ----");
  if (repoDir && runId) {
    const rd = runDirFor(repoDir, runId);

    for (const [taskId, w] of workers) {
      console.error(`[m4-accept] -- task ${taskId} (worker ${w.workerId ?? "<none>"}) --`);
      if (w.workerId) {
        console.error(`[m4-accept] meta.json (${workerMetaPath(w.workerId)}):`);
        console.error(await tailFile(workerMetaPath(w.workerId)));
        try {
          const res = await callTool("stream_worker_log", { workerId: w.workerId, sinceSeq: 0 });
          console.error(`[m4-accept] log events: ${JSON.stringify(res.data, null, 2).slice(-3000)}`);
        } catch (err) {
          console.error(`<could not fetch worker log: ${err.message}>`);
        }
      }
    }

    const serveLog = path.join(rd, "opencode-serve.log");
    console.error(`[m4-accept] opencode-serve.log tail (${serveLog}):`);
    console.error(await tailFile(serveLog));

    const eventsLog = path.join(rd, "events.jsonl");
    console.error(`[m4-accept] run events.jsonl tail (${eventsLog}):`);
    console.error(await tailFile(eventsLog));

    const reportPath = path.join(rd, "report.md");
    console.error(`[m4-accept] report.md (${reportPath}):`);
    console.error(await tailFile(reportPath));
  }
  if (scratchRoot) {
    console.error(`[m4-accept] scratch dir PRESERVED for inspection: ${scratchRoot}`);
  }
  console.error("[m4-accept] ---- end diagnostics ----\n");
}

async function fail(message) {
  console.error(`\n[m4-accept] FAILURE: ${message}`);
  await dumpDiagnostics().catch((err) => console.error(`[m4-accept] diagnostics dump itself failed: ${err.message}`));
  process.exit(1);
}

async function main() {
  log("building packages/core (npm run build)...");
  run("npm", ["run", "build"], REPO_ROOT, { stdio: "inherit", shell: true });
  log("build ok");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  scratchRoot = path.join(SCRATCH_BASE_DIR, `accept-${ts}`);
  repoDir = path.join(scratchRoot, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });

  log(`scratch repo: ${repoDir}`);
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "m4-accept@agentic-os.local"], repoDir);
  git(["config", "user.name", "Agentic OS M4 Accept"], repoDir);
  git(["config", "core.autocrlf", "false"], repoDir);

  // Trivial package.json: "typecheck" and "test" both exit 0 -- so
  // config/orchestrator.yaml's "full" check suite (typecheck + test), which
  // integrate_batch runs as the regression check, passes against this toy
  // repo regardless of what the worker adds.
  const pkg = {
    name: "agentic-m4-toy",
    private: true,
    version: "0.0.0",
    scripts: {
      typecheck: "node -e \"\"",
      test: "node -e \"\""
    }
  };
  await writeFile(path.join(repoDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  await writeFile(path.join(repoDir, ".gitignore"), "node_modules/\n", "utf8");
  git(["add", "package.json", ".gitignore"], repoDir);
  git(["commit", "-m", "initial commit"], repoDir);

  // -- Live custom-check override (M4 extension point) ---------------------
  // A PARTIAL override -- only the `checks` key. config/index.ts's loadFile
  // deep-merges this over the shipped config/orchestrator.yaml, so
  // budget/replan/humanGates/worker/worktree still come from the shipped
  // defaults untouched, and `checks.suites` gains a `smoke` suite alongside
  // the shipped `quick`/`full` ones. This proves a project can add a check
  // command with zero code change, not just a config-file swap.
  const overrideDir = path.join(repoDir, ".agentic-os", "config");
  await mkdir(overrideDir, { recursive: true });
  const overrideYaml = [
    "checks:",
    "  suites:",
    "    smoke:",
    `      - name: ${CUSTOM_CHECK_NAME}`,
    '        command: "node -e \\"process.exit(0)\\""',
    "        timeoutMs: 5000",
    ""
  ].join("\n");
  await writeFile(path.join(overrideDir, "orchestrator.yaml"), overrideYaml, "utf8");
  log(`wrote project override: ${path.join(overrideDir, "orchestrator.yaml")} (adds '${CUSTOM_SUITE}' check suite)`);

  const { createAgenticMcpServer } = await import("../packages/core/dist/mcp/server.js");
  agenticServer = await createAgenticMcpServer({ projectDir: repoDir, platformConfigDir: PLATFORM_CONFIG_DIR });

  runId = JSON.parse(await readFile(path.join(repoDir, ".agentic-os", "current-run.json"), "utf8")).runId;
  log(`runId: ${runId}`);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await agenticServer.server.connect(serverTransport);
  mcpClient = new Client({ name: "m4-accept-client", version: "0.0.0" });
  await mcpClient.connect(clientTransport);

  // -- 1. plan_submit: one task -------------------------------------------------
  log("plan_submit (1 task)...");
  const planned = await callTool("plan_submit", {
    objective: "M4 acceptance: one trivial file-creation task proving observability (run_report) and a live custom check-suite override.",
    tasks: [
      {
        id: TASK.id,
        title: TASK.title,
        prompt: TASK.prompt,
        dependsOn: [],
        fileOwnership: TASK.fileOwnership
      }
    ]
  });
  if (planned.isError || !planned.data?.valid) {
    await fail(`plan_submit failed: ${JSON.stringify(planned.data)}`);
    return;
  }
  log(`plan submitted: planId=${planned.data.planId} taskCount=${planned.data.taskCount}`);

  // -- 2. next_batch --------------------------------------------------------------
  log("next_batch...");
  const batch = await callTool("next_batch", {});
  if (batch.isError || !batch.data?.batchId || (batch.data.tasks ?? []).length !== 1) {
    await fail(`next_batch did not return the 1 ready task: ${JSON.stringify(batch.data)}`);
    return;
  }
  const batchId = batch.data.batchId;
  log(`batchId=${batchId}, ready tasks: ${batch.data.tasks.map((t) => t.id).join(", ")}`);

  // -- 3. spawn_worker --------------------------------------------------------------
  log(`spawn_worker taskId=${TASK.id} (model: config/models.yaml routing.default = auto:free)...`);
  const spawned = await callTool("spawn_worker", { taskId: TASK.id, prompt: TASK.prompt });
  if (spawned.isError) {
    await fail(`spawn_worker(${TASK.id}) returned isError: ${JSON.stringify(spawned.data)}`);
    return;
  }
  workers.set(TASK.id, {
    workerId: spawned.data.workerId,
    file: TASK.file,
    verifyCommand: `node -e "process.exit(require('fs').existsSync('${TASK.file}')?0:1)"`,
    lastState: spawned.data.state,
    unchangedPolls: 0,
    sinceSeq: 0,
    processed: false,
    failed: false
  });
  log(`  -> workerId=${spawned.data.workerId} worktree=${spawned.data.worktreePath}`);

  // -- 4. poll worker_status; collect+verify as it completes ----------------------
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const status = await callTool("worker_status", {});
    if (status.isError) {
      await fail(`worker_status returned isError: ${JSON.stringify(status.data)}`);
      return;
    }
    const byId = new Map((status.data.workers ?? []).map((w) => [w.workerId, w]));

    for (const [taskId, w] of workers) {
      if (w.processed) continue;
      const info = byId.get(w.workerId);
      if (!info) continue;
      log(`task=${taskId} worker=${w.workerId} state=${info.state} costUsd=${info.costUsd ?? 0}`);

      if (info.state === w.lastState) {
        w.unchangedPolls++;
      } else {
        w.unchangedPolls = 0;
        w.lastState = info.state;
      }

      if (IN_FLIGHT_STATES.has(info.state) && w.unchangedPolls > 0 && w.unchangedPolls % STUCK_POLLS === 0) {
        log(`  task=${taskId} looks stuck in '${info.state}' for ${w.unchangedPolls * POLL_MS / 1000}s; streaming its log...`);
        const streamed = await callTool("stream_worker_log", { workerId: w.workerId, sinceSeq: w.sinceSeq });
        if (!streamed.isError && streamed.data) {
          for (const evt of streamed.data.events ?? []) {
            log(`    [${taskId} log seq=${evt.seq}] ${evt.type}${evt.summary ? `: ${evt.summary}` : ""}`);
          }
          w.sinceSeq = streamed.data.nextSinceSeq ?? w.sinceSeq;
        }
      }

      if (info.state === "completed") {
        log(`task=${taskId} completed; collect_worker + verify_worker...`);
        const collected = await callTool("collect_worker", { workerId: w.workerId });
        log(`  collect: filesChanged=${JSON.stringify(collected.data?.filesChanged)}`);
        const verified = await callTool("verify_worker", { workerId: w.workerId, command: w.verifyCommand });
        w.processed = true;
        if (verified.isError || !verified.data?.passed) {
          w.failed = true;
          log(`  verify_worker FAILED for task=${taskId}: ${JSON.stringify(verified.data)}`);
        } else {
          log(`  verify_worker passed for task=${taskId}`);
        }
      } else if (FAILURE_STATES.has(info.state)) {
        w.processed = true;
        w.failed = true;
        log(`task=${taskId} reached failure state '${info.state}': ${JSON.stringify(info.lastError ?? {})}`);
      }
    }

    if ([...workers.values()].every((w) => w.processed)) break;

    if (Date.now() > deadline) {
      for (const [taskId, w] of workers) {
        if (!w.processed) {
          await callTool("abort_worker", { workerId: w.workerId, reason: "m4-accept exceeded 10 minute wait" }).catch(() => {});
          log(`aborted still-in-flight task=${taskId} worker=${w.workerId}`);
        }
      }
      await fail(`timed out after ${MAX_WAIT_MS}ms waiting for worker to complete+verify`);
      return;
    }
    await sleep(POLL_MS);
  }

  const failedTasks = [...workers.entries()].filter(([, w]) => w.failed).map(([taskId]) => taskId);
  if (failedTasks.length > 0) {
    await fail(`task(s) failed to complete+verify: ${failedTasks.join(", ")}`);
    return;
  }
  log("worker completed and verified");

  // -- 5. run_check_suite: custom 'smoke' suite runs live -------------------------
  // No workerId/path -- runs against projectDir itself, where the override
  // config lives, proving the override actually took effect.
  log(`run_check_suite(suiteName='${CUSTOM_SUITE}') against projectDir...`);
  const checked = await callTool("run_check_suite", { suiteName: CUSTOM_SUITE });
  if (checked.isError || checked.data?.passed !== true) {
    await fail(`run_check_suite('${CUSTOM_SUITE}') did not report passed:true: ${JSON.stringify(checked.data)}`);
    return;
  }
  const customCheckNames = (checked.data.checks ?? []).map((c) => c.name);
  if (!customCheckNames.includes(CUSTOM_CHECK_NAME)) {
    await fail(`run_check_suite('${CUSTOM_SUITE}') results missing custom check '${CUSTOM_CHECK_NAME}': ${JSON.stringify(checked.data)}`);
    return;
  }
  log(`custom check suite '${CUSTOM_SUITE}' passed live, checks=[${customCheckNames.join(", ")}]`);

  // -- 6. integrate_batch -----------------------------------------------------------
  log(`integrate_batch batchId=${batchId} regressionSuite=${REGRESSION_SUITE}...`);
  const integrated = await callTool("integrate_batch", { batchId, regressionSuite: REGRESSION_SUITE });
  if (integrated.isError || !integrated.data?.allMerged || !integrated.data?.allPassed) {
    await fail(`integrate_batch did not report allMerged+allPassed: ${JSON.stringify(integrated.data)}`);
    return;
  }
  const integrationBranch = integrated.data.integrationBranch;
  log(`integrated onto '${integrationBranch}': merges=${JSON.stringify(integrated.data.merges)}`);
  log(`regression (${REGRESSION_SUITE}) passed=${integrated.data.regressionCheck?.passed}`);

  // Assert directly on the integration branch (never trust self-report).
  const fileCheck = git(["cat-file", "-e", `${integrationBranch}:${TASK.file}`], repoDir, { allowFail: true });
  if (fileCheck.status !== 0) {
    await fail(`${TASK.file} not found on integration branch '${integrationBranch}' (git cat-file -e failed)`);
    return;
  }
  log(`assertion passed: ${TASK.file} present on integration branch`);

  // -- 7. run_report ------------------------------------------------------------------
  log("run_report...");
  const reported = await callTool("run_report", {});
  if (reported.isError) {
    await fail(`run_report returned isError: ${JSON.stringify(reported.data)}`);
    return;
  }
  const { summary, reportPath, markdown } = reported.data ?? {};
  if (!summary || summary.tasks?.total !== 1) {
    await fail(`run_report summary.tasks.total !== 1: ${JSON.stringify(summary)}`);
    return;
  }
  if (!(summary.workers?.total >= 1)) {
    await fail(`run_report summary.workers.total < 1: ${JSON.stringify(summary)}`);
    return;
  }
  if (typeof markdown !== "string" || !markdown.includes("```mermaid\ngantt")) {
    await fail(`run_report markdown missing mermaid gantt (timeline) fence: ${JSON.stringify(markdown?.slice(0, 500))}`);
    return;
  }
  if (!markdown.includes("```mermaid\ngraph TD")) {
    await fail(`run_report markdown missing mermaid graph TD (task DAG) fence: ${JSON.stringify(markdown?.slice(0, 500))}`);
    return;
  }
  if (!markdown.includes("## Model & Cost Usage")) {
    await fail(`run_report markdown missing '## Model & Cost Usage' table: ${JSON.stringify(markdown?.slice(0, 500))}`);
    return;
  }
  if (typeof reportPath !== "string" || !(await pathExists(reportPath))) {
    await fail(`run_report reportPath does not exist on disk: ${reportPath}`);
    return;
  }
  const reportOnDisk = await readFile(reportPath, "utf8");
  if (reportOnDisk !== markdown) {
    await fail(
      `run_report's on-disk ${reportPath} does not match the markdown returned inline ` +
        `(lengths: disk=${reportOnDisk.length} inline=${markdown.length})`
    );
    return;
  }
  log(`run_report verified: tasks.total=${summary.tasks.total} workers.total=${summary.workers.total} reportPath=${reportPath}`);
  log("run_report markdown contains both mermaid fences (gantt timeline + graph TD task DAG) and the Model & Cost Usage table");

  // -- 8. final report ------------------------------------------------------------
  const integrationSha = git(["rev-parse", integrationBranch], repoDir).stdout.trim();
  const finalStatus = await callTool("worker_status", {}).catch(() => undefined);
  const totalCost = finalStatus?.data?.budget?.committedUsd ?? 0;

  const perTaskModels = {};
  for (const [taskId, w] of workers) {
    const meta = await readWorkerMetaJson(w.workerId);
    perTaskModels[taskId] = meta.model ?? "<unknown>";
  }

  if (totalCost > 0.05) {
    await fail(`total committed cost $${totalCost} is not ~$0 -- a non-free model may have been used`);
    return;
  }

  console.log("\n[m4-accept] ==== FINAL REPORT ====");
  console.log("per-task results:");
  for (const [taskId, w] of workers) {
    console.log(`  ${taskId}: workerId=${w.workerId} state=${w.lastState} model=${perTaskModels[taskId]} failed=${w.failed}`);
  }
  console.log(`custom check suite: '${CUSTOM_SUITE}' (added via .agentic-os/config/orchestrator.yaml override) -> passed=${checked.data.passed}, checks=[${customCheckNames.join(", ")}]`);
  console.log(`total committed cost: $${totalCost}`);
  console.log(`integration branch: ${integrationBranch} @ ${integrationSha}`);
  console.log(`file merged: ${TASK.file}`);
  console.log(`regression suite '${REGRESSION_SUITE}': passed=${integrated.data.regressionCheck?.passed}`);
  console.log(`run_report: report.md written to ${reportPath}, matches inline markdown, contains gantt timeline + task DAG mermaid diagrams and a Model & Cost table`);
  console.log("[m4-accept] ==== ACCEPTANCE PASSED ====\n");

  // -- 9. cleanup (success only) ------------------------------------------------
  await mcpClient.close().catch(() => {});
  await agenticServer.close().catch(() => {});

  try {
    const serverJsonPath = path.join(runDirFor(repoDir, runId), "server.json");
    const serverJson = JSON.parse(await readFile(serverJsonPath, "utf8"));
    log(`killing spawned opencode serve (pid ${serverJson.pid})...`);
    run("taskkill", ["/PID", String(serverJson.pid), "/T", "/F"], REPO_ROOT, { allowFail: true, stdio: "ignore" });
  } catch (err) {
    log(`no server.json to clean up (${err.message})`);
  }

  await sleep(500); // let the OS release file handles before rm (Windows worktree-handle race; see smoke.mjs)

  const worktreesDir = `${repoDir}-agentic-worktrees`;
  await rm(worktreesDir, { recursive: true, force: true }).catch(() => {});
  await rm(scratchRoot, { recursive: true, force: true }).catch((err) =>
    log(`could not fully remove scratch dir (non-fatal): ${err.message}`)
  );

  log("cleanup done");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`[m4-accept] unexpected error: ${err.stack ?? err.message}`);
  await dumpDiagnostics().catch(() => {});
  process.exit(1);
});
