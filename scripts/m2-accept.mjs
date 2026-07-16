#!/usr/bin/env node
/**
 * scripts/m2-accept.mjs — M2 acceptance test for Cohort.
 *
 * Proves the multi-worker pipeline works end-to-end with REAL OpenCode
 * workers on free models, driven entirely through the real MCP tool surface:
 * plan_submit -> next_batch -> spawn_worker x3 (disjoint fileOwnership, no
 * deps) -> worker_status polling -> collect_worker/verify_worker per worker
 * -> integrate_batch (with a regression suite) -> batch_status.
 *
 * Structurally a sibling of scripts/smoke.mjs (M1's single-worker smoke):
 * same build-then-scratch-repo-then-MCP-client shape, same poll pattern,
 * same Windows post-merge worktree-handle race handling, same "keep the
 * scratch dir on failure" diagnostics contract. Extended for N workers
 * running concurrently instead of one.
 *
 * Usage: npm run m2-accept
 * Env:   M2_SCRATCH_DIR  optional override for the scratch repo/worktrees
 *                          root; defaults under os.tmpdir() (see
 *                          smoke.mjs's SMOKE_SCRATCH_DIR doc for why: a
 *                          scratch git repo/worktrees must never nest inside
 *                          this platform repo itself).
 *
 * Notes verified against source, not assumed:
 *   - config/models.yaml's routing.default is already "auto:free" -- no
 *     explicit `model` is passed to spawn_worker anywhere in this script;
 *     the MCP server resolves it once per server instance via
 *     model-catalog/resolveFreeModel (memoized in ctx.cachedFreeModel), so
 *     staying free requires no action here.
 *   - run_report is NOT registered as an MCP tool (grepped packages/core/src
 *     for "run_report": no matches) -- step 7 below just notes this instead
 *     of calling it. It's presumably an M4 tool.
 *   - spawn_worker/worker_status/collect_worker responses do not include
 *     which model a worker used (WorkerMeta.model is persisted to
 *     meta.json but not surfaced through compactWorker's payload) -- the
 *     final report reads meta.json directly per worker, same file
 *     dumpDiagnostics() already reads for failure diagnostics.
 *   - No in-script auto:free-fails-so-try-another-candidate loop is
 *     implemented: the resolution is memoized ONCE per MCP server instance
 *     (all three workers share one resolved model), and ORCHESTRATION.md's
 *     "root-cause before retrying" / "do NOT loop" doctrine argues against
 *     building an untested retry-with-different-model loop into a one-shot
 *     acceptance script. On a model-caused failure this script fails fast
 *     with full diagnostics (including which model was used) so a human can
 *     decide whether to re-run with a different explicit `model`.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLATFORM_CONFIG_DIR = path.join(REPO_ROOT, "config");
const SCRATCH_BASE_DIR = process.env.M2_SCRATCH_DIR ?? path.join(os.tmpdir(), "agentic-m2-accept");

const POLL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const REGRESSION_SUITE = "full"; // config/orchestrator.yaml checks.suites.full = typecheck + test

const FAILURE_STATES = new Set(["failed", "timeout", "aborted", "orphaned", "verification_failed"]);
// Mirrors mcp/server.ts's IN_FLIGHT_WORKER_STATES -- states where streaming
// the worker's log while it looks stuck is meaningful.
const IN_FLIGHT_STATES = new Set([
  "created",
  "worktree_provisioning",
  "worktree_ready",
  "session_starting",
  "running",
  "verifying"
]);
// Poll count (at POLL_MS each) a worker must sit unchanged in an in-flight
// state before we consider it "looks stuck" and stream its log.
const STUCK_POLLS = 6; // 30s

// Prompts explicitly ask the worker to `git commit` its own change.
// Root-caused against a real m2-accept run (see git history / PR
// description): integrate_batch's merge path (worktree/integration.ts's
// mergeInDagOrder -> mergeBranch) merges each worker's branch as-is and has
// no auto-commit step -- unlike finalize_worker's merge path
// (worker/index.ts), which explicitly `git add -A && git commit`s whatever
// is left uncommitted before merging. verify_worker's file-existence check
// only looks at the worktree's filesystem, so a worker that creates a file
// but never commits it still verifies "passed" -- and integrate_batch then
// silently merges nothing (mergeSha === the branch's unchanged base commit,
// reported as allMerged:true/allPassed:true regardless). Telling the worker
// to commit is the correct fix at this layer: it's the M2 pipeline's actual
// contract (a worker's committed history is what integrate_batch merges),
// not a workaround for a bug in this script.
const TASKS = [
  {
    id: "feat-a",
    title: "Add function in src/a.js",
    file: "src/a.js",
    fileOwnership: ["src/a.js"],
    prompt:
      "Create src/a.js exporting a function add(x,y) returning x+y. Only create that file. " +
      "Then run `git add src/a.js` and `git commit -m \"add: src/a.js\"` to commit it."
  },
  {
    id: "feat-b",
    title: "Subtract function in src/b.js",
    file: "src/b.js",
    fileOwnership: ["src/b.js"],
    prompt:
      "Create src/b.js exporting a function subtract(x,y) returning x-y. Only create that file. " +
      "Then run `git add src/b.js` and `git commit -m \"add: src/b.js\"` to commit it."
  },
  {
    id: "feat-c",
    title: "Multiply function in src/c.js",
    file: "src/c.js",
    fileOwnership: ["src/c.js"],
    prompt:
      "Create src/c.js exporting a function multiply(x,y) returning x*y. Only create that file. " +
      "Then run `git add src/c.js` and `git commit -m \"add: src/c.js\"` to commit it."
  }
];

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
  console.log(`[m2-accept ${new Date().toISOString()}]`, ...args);
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

async function tailFile(filePath, maxChars = 4000) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.length > maxChars ? `...(truncated)...\n${content.slice(-maxChars)}` : content;
  } catch (err) {
    return `<could not read ${filePath}: ${err.message}>`;
  }
}

function runDirFor(repo, id) {
  return path.join(repo, ".cohort", "runs", id);
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
  console.error("\n[m2-accept] ---- diagnostics ----");
  if (repoDir && runId) {
    const rd = runDirFor(repoDir, runId);

    for (const [taskId, w] of workers) {
      console.error(`[m2-accept] -- task ${taskId} (worker ${w.workerId ?? "<none>"}) --`);
      if (w.workerId) {
        console.error(`[m2-accept] meta.json (${workerMetaPath(w.workerId)}):`);
        console.error(await tailFile(workerMetaPath(w.workerId)));
        try {
          const res = await callTool("stream_worker_log", { workerId: w.workerId, sinceSeq: 0 });
          console.error(`[m2-accept] log events: ${JSON.stringify(res.data, null, 2).slice(-3000)}`);
        } catch (err) {
          console.error(`<could not fetch worker log: ${err.message}>`);
        }
      }
    }

    const serveLog = path.join(rd, "opencode-serve.log");
    console.error(`[m2-accept] opencode-serve.log tail (${serveLog}):`);
    console.error(await tailFile(serveLog));

    const eventsLog = path.join(rd, "events.jsonl");
    console.error(`[m2-accept] run events.jsonl tail (${eventsLog}):`);
    console.error(await tailFile(eventsLog));
  }
  if (scratchRoot) {
    console.error(`[m2-accept] scratch dir PRESERVED for inspection: ${scratchRoot}`);
  }
  console.error("[m2-accept] ---- end diagnostics ----\n");
}

async function fail(message) {
  console.error(`\n[m2-accept] FAILURE: ${message}`);
  await dumpDiagnostics().catch((err) => console.error(`[m2-accept] diagnostics dump itself failed: ${err.message}`));
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
  git(["config", "user.email", "m2-accept@cohort.local"], repoDir);
  git(["config", "user.name", "Cohort M2 Accept"], repoDir);
  git(["config", "core.autocrlf", "false"], repoDir);

  // Trivial package.json: a "test" script the top-level ask requires, plus
  // "typecheck" -- both exit 0 -- so config/orchestrator.yaml's "full" check
  // suite (typecheck + test), which integrate_batch runs as the regression
  // check, passes against this toy repo regardless of what the workers add.
  const pkg = {
    name: "agentic-m2-toy",
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

  const { createAgenticMcpServer } = await import("../packages/core/dist/mcp/server.js");
  agenticServer = await createAgenticMcpServer({ projectDir: repoDir, platformConfigDir: PLATFORM_CONFIG_DIR });

  runId = JSON.parse(await readFile(path.join(repoDir, ".cohort", "current-run.json"), "utf8")).runId;
  log(`runId: ${runId}`);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await agenticServer.server.connect(serverTransport);
  mcpClient = new Client({ name: "m2-accept-client", version: "0.0.0" });
  await mcpClient.connect(clientTransport);

  // -- 1. plan_submit ---------------------------------------------------------
  log("plan_submit (3 disjoint, dependency-free tasks)...");
  const planned = await callTool("plan_submit", {
    objective: "M2 acceptance: three independent trivial file-creation tasks proving the multi-worker pipeline.",
    tasks: TASKS.map((t) => ({
      id: t.id,
      title: t.title,
      prompt: t.prompt,
      dependsOn: [],
      fileOwnership: t.fileOwnership
    }))
  });
  if (planned.isError || !planned.data?.valid) {
    await fail(`plan_submit failed: ${JSON.stringify(planned.data)}`);
    return;
  }
  log(`plan submitted: planId=${planned.data.planId} taskCount=${planned.data.taskCount}`);

  // -- 2. next_batch ------------------------------------------------------------
  log("next_batch...");
  const batch = await callTool("next_batch", {});
  if (batch.isError || !batch.data?.batchId || (batch.data.tasks ?? []).length !== TASKS.length) {
    await fail(`next_batch did not return all ${TASKS.length} disjoint tasks as ready: ${JSON.stringify(batch.data)}`);
    return;
  }
  const batchId = batch.data.batchId;
  log(`batchId=${batchId}, ready tasks: ${batch.data.tasks.map((t) => t.id).join(", ")}`);

  // -- 3. spawn one worker per ready task ----------------------------------------
  for (const t of TASKS) {
    log(`spawn_worker taskId=${t.id} (model: config/models.yaml routing.default = auto:free)...`);
    const spawned = await callTool("spawn_worker", { taskId: t.id, prompt: t.prompt });
    if (spawned.isError) {
      await fail(`spawn_worker(${t.id}) returned isError: ${JSON.stringify(spawned.data)}`);
      return;
    }
    workers.set(t.id, {
      workerId: spawned.data.workerId,
      file: t.file,
      verifyCommand: `node -e "process.exit(require('fs').existsSync('${t.file}')?0:1)"`,
      lastState: spawned.data.state,
      unchangedPolls: 0,
      sinceSeq: 0,
      processed: false,
      failed: false
    });
    log(`  -> workerId=${spawned.data.workerId} worktree=${spawned.data.worktreePath}`);
  }

  // -- 4/5. poll worker_status; collect+verify each worker as it completes ------
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
          await callTool("abort_worker", { workerId: w.workerId, reason: "m2-accept exceeded 10 minute wait" }).catch(() => {});
          log(`aborted still-in-flight task=${taskId} worker=${w.workerId}`);
        }
      }
      await fail(`timed out after ${MAX_WAIT_MS}ms waiting for all workers to complete+verify`);
      return;
    }
    await sleep(POLL_MS);
  }

  const failedTasks = [...workers.entries()].filter(([, w]) => w.failed).map(([taskId]) => taskId);
  if (failedTasks.length > 0) {
    await fail(`task(s) failed to complete+verify: ${failedTasks.join(", ")}`);
    return;
  }
  log("all 3 workers completed and verified");

  // -- 6. integrate_batch ---------------------------------------------------------
  log(`integrate_batch batchId=${batchId} regressionSuite=${REGRESSION_SUITE}...`);
  const integrated = await callTool("integrate_batch", { batchId, regressionSuite: REGRESSION_SUITE });
  if (integrated.isError || !integrated.data?.allMerged || !integrated.data?.allPassed) {
    await fail(`integrate_batch did not report allMerged+allPassed: ${JSON.stringify(integrated.data)}`);
    return;
  }
  const integrationBranch = integrated.data.integrationBranch;
  log(`integrated onto '${integrationBranch}': merges=${JSON.stringify(integrated.data.merges)}`);
  log(`regression (${REGRESSION_SUITE}) passed=${integrated.data.regressionCheck?.passed}`);

  // Assert directly on the integration branch (never trust self-report) --
  // each task's file must exist as a blob on that branch, without checking
  // it out (projectDir is back on the base branch by now).
  for (const t of TASKS) {
    const check = git(["cat-file", "-e", `${integrationBranch}:${t.file}`], repoDir, { allowFail: true });
    if (check.status !== 0) {
      await fail(`${t.file} not found on integration branch '${integrationBranch}' (git cat-file -e failed)`);
      return;
    }
  }
  log("assertions passed: all 3 files present on integration branch");

  // -- 7. batch_status + run_report (if it exists) -------------------------------
  const finalBatchStatus = await callTool("batch_status", { batchId });
  if (finalBatchStatus.isError || finalBatchStatus.data?.status !== "integrated") {
    await fail(`batch_status did not report 'integrated': ${JSON.stringify(finalBatchStatus.data)}`);
    return;
  }
  log(`batch_status confirms status='integrated', allTerminal=${finalBatchStatus.data.allTerminal}`);

  let runReportNote = "run_report tool is not registered on this MCP server (verified: grepped packages/core/src for 'run_report', no matches) -- presumably lands in M4. Skipped.";
  log(runReportNote);

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

  console.log("\n[m2-accept] ==== FINAL REPORT ====");
  console.log("per-task results:");
  for (const [taskId, w] of workers) {
    console.log(`  ${taskId}: workerId=${w.workerId} state=${w.lastState} model=${perTaskModels[taskId]} failed=${w.failed}`);
  }
  console.log(`total committed cost: $${totalCost}`);
  console.log(`integration branch: ${integrationBranch} @ ${integrationSha}`);
  console.log(`files merged: ${TASKS.map((t) => t.file).join(", ")}`);
  console.log(`regression suite '${REGRESSION_SUITE}': passed=${integrated.data.regressionCheck?.passed}`);
  console.log(runReportNote);
  console.log("[m2-accept] ==== ACCEPTANCE PASSED ====\n");

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
  console.error(`[m2-accept] unexpected error: ${err.stack ?? err.message}`);
  await dumpDiagnostics().catch(() => {});
  process.exit(1);
});
