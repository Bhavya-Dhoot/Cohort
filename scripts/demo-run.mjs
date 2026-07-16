#!/usr/bin/env node
/**
 * scripts/demo-run.mjs — two-phase live demo driver for Cohort's
 * autonomous loop, split around a REAL Claude-subagent review step.
 *
 * Unlike scripts/m3-accept.mjs (a single-process acceptance test that
 * records its own canned reviewer verdicts), this script is invoked TWICE by
 * the orchestrator as two separate OS processes:
 *
 *   node scripts/demo-run.mjs build      -- plans, generates specialists,
 *     spawns real OpenCode workers, verifies them, and hands off each
 *     task's real diff to disk as <scratchRoot>/handoff.json.
 *
 *   [the orchestrator runs real Claude reviewer subagents against the
 *    diffs in handoff.json here, out-of-process, and writes their
 *    verdicts to <scratchRoot>/verdicts.json]
 *
 *   node scripts/demo-run.mjs integrate  -- reattaches to the SAME run
 *     (via .cohort/current-run.json), records the real verdicts,
 *     excludes any blocked task from the merge, integrates the rest,
 *     retires the specialists, and renders run_report.
 *
 *   node scripts/demo-run.mjs reset      -- wipes the scratch dir so a
 *     fresh demo can start clean. The orchestrator runs this before
 *     'build'; it is not run automatically by this script.
 *
 * Two invocations sharing one run only works because the scratch project
 * directory is FIXED (not timestamped, unlike M2/M3/M4's *_SCRATCH_DIR) --
 * both phases resolve the identical <projectDir>/.cohort/current-run.json
 * and therefore converge on the identical runId (see mcp/server.ts's
 * resolveRunId). DEMO_DIR overrides the scratch root for both phases; it
 * must be set identically for 'build' and 'integrate' or they will not agree
 * on a runId.
 *
 * Structurally a sibling of scripts/m3-accept.mjs: same build-then-scratch-
 * repo-then-MCP-client shape, same poll pattern, same Windows post-merge
 * worktree-handle race handling, same "keep the scratch dir on failure"
 * diagnostics contract. Extended here for the two-phase split and for
 * excluding a reviewer-blocked task from integrate_batch's merge set.
 *
 * Usage: node scripts/demo-run.mjs <build|integrate|reset>
 * Env:   DEMO_DIR  optional override for the scratch root (parent of the
 *          fixed 'project' dir and of handoff.json/verdicts.json);
 *          defaults under os.tmpdir().
 *
 * Notes verified against source, not assumed:
 *   - integrate_batch (mcp/server.ts's doIntegrateBatch) only merges tasks
 *     whose worker is currently in state 'verified' -- anything else in the
 *     batch is reported separately as `notVerified` and simply skipped, not
 *     treated as an error. finalize_worker('discard') is valid from
 *     'verified' (worker/index.ts's DISCARDABLE_STATES includes 'verified')
 *     and moves the worker to a terminal 'discarded' state. So calling
 *     finalize_worker(workerId, 'discard') on a blocked task's worker BEFORE
 *     integrate_batch is the real tool-surface way to keep that task out of
 *     the merge: integrate_batch will see it as not-'verified' and skip it,
 *     while the rest of the batch still integrates normally in the same call.
 *   - review_verdict('get')'s summary.blocking is true when any reviewer's
 *     LATEST verdict for that task is 'revise' or 'block' (review/schema.ts's
 *     anti-rubber-stamp rule requires >=1 concrete finding for either).
 *   - report/index.ts's generateRunReport always emits a
 *     "```mermaid\ngantt" timeline fence and a "```mermaid\ngraph TD" task
 *     DAG fence plus a "## Model & Cost Usage" table whenever at least one
 *     worker/task exists (confirmed by scripts/m4-accept.mjs's own
 *     assertions on the same render function).
 *   - config/orchestrator.yaml's worker.maxConcurrent is 3, matching this
 *     demo's 3 disjoint-file-ownership tasks exactly -- one next_batch call
 *     selects all three.
 *   - config/models.yaml's routing.default is already "auto:free" -- no
 *     explicit `model` is passed to spawn_worker anywhere in this script.
 *   - No in-script retry-with-different-model loop, per ORCHESTRATION.md's
 *     "root-cause before retrying" doctrine (same stance m2/m3/m4-accept.mjs
 *     document) -- on a model-caused failure this script fails fast with
 *     full diagnostics and keeps the scratch dir.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLATFORM_CONFIG_DIR = path.join(REPO_ROOT, "config");

// Fixed (NOT timestamped) scratch root -- both phases, run as separate
// processes, must resolve the same .cohort/current-run.json and
// therefore the same runId. DEMO_DIR overrides the root.
const SCRATCH_ROOT = process.env.DEMO_DIR ?? path.join(os.tmpdir(), "agentic-demo-run");
const REPO_DIR = path.join(SCRATCH_ROOT, "project");
const HANDOFF_PATH = path.join(SCRATCH_ROOT, "handoff.json");
const VERDICTS_PATH = path.join(SCRATCH_ROOT, "verdicts.json");

const POLL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const REGRESSION_SUITE = "full"; // config/orchestrator.yaml checks.suites.full = typecheck + test
const BASE_BRANCH = "main"; // this script always `git init -b main`
const DIFF_CHAR_CAP = 4000;

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

const OBJECTIVE =
  "Build a small Node utility library: a config loader, an input validator, and a health-check handler.";

// Three domains the dynamic org is generated around.
const DOMAINS = [
  { id: "config", name: "Configuration" },
  { id: "validation", name: "Validation" },
  { id: "health", name: "Health Check" }
];

// CEO -> EM -> three domain leads, each with one specialist + one reviewer.
const ORG_CHART = {
  root: {
    role: "CEO",
    kind: "executive",
    children: [
      {
        role: "Engineering Manager",
        kind: "manager",
        children: [
          {
            role: "Domain Lead: Configuration",
            kind: "domain-lead",
            domain: "config",
            children: [
              { role: "Specialist: Config Engineer", kind: "specialist", domain: "config", specialistArchetype: "config-engineer" },
              { role: "Reviewer: Architecture", kind: "reviewer", domain: "config", reviewerId: "architecture" }
            ]
          },
          {
            role: "Domain Lead: Validation",
            kind: "domain-lead",
            domain: "validation",
            children: [
              { role: "Specialist: Validation Engineer", kind: "specialist", domain: "validation", specialistArchetype: "validation-engineer" },
              { role: "Reviewer: Security", kind: "reviewer", domain: "validation", reviewerId: "security" }
            ]
          },
          {
            role: "Domain Lead: Health Check",
            kind: "domain-lead",
            domain: "health",
            children: [
              { role: "Specialist: Health Engineer", kind: "specialist", domain: "health", specialistArchetype: "health-engineer" },
              { role: "Reviewer: Testing", kind: "reviewer", domain: "health", reviewerId: "testing" }
            ]
          }
        ]
      }
    ]
  },
  generatedFor: OBJECTIVE
};

// Prompts explicitly ask the worker to `git commit` its own change -- see
// m2-accept.mjs's doc comment for why (integrate_batch merges each worker's
// branch as-is; verify_worker only checks the worktree's filesystem).
const TASKS = [
  {
    id: "feat-config",
    title: "Add src/config.js",
    file: "src/config.js",
    domain: "config",
    agentId: "config-engineer",
    fileOwnership: ["src/config.js"],
    prompt:
      "Create src/config.js exporting a function loadConfig(obj) that returns obj merged over the defaults " +
      '{port:3000,env:"dev"} (obj\'s own properties take precedence). Only create that file. ' +
      'Then run `git add src/config.js` and `git commit -m "add: src/config.js"` to commit it.'
  },
  {
    id: "feat-validate",
    title: "Add src/validate.js",
    file: "src/validate.js",
    domain: "validation",
    agentId: "validation-engineer",
    fileOwnership: ["src/validate.js"],
    prompt:
      "Create src/validate.js exporting a function isNonEmptyString(x) that returns true if and only if x is a " +
      "string with length greater than 0, and false otherwise. Only create that file. " +
      'Then run `git add src/validate.js` and `git commit -m "add: src/validate.js"` to commit it.'
  },
  {
    id: "feat-health",
    title: "Add src/health.js",
    file: "src/health.js",
    domain: "health",
    agentId: "health-engineer",
    fileOwnership: ["src/health.js"],
    prompt:
      'Create src/health.js exporting a function health() that returns {status:"ok"}. Only create that file. ' +
      'Then run `git add src/health.js` and `git commit -m "add: src/health.js"` to commit it.'
  }
];

// The three specialists generated for this run, one per domain.
const SPECIALISTS = [
  {
    agentId: "config-engineer",
    role: "Config Engineer",
    description: "Owns configuration-loading code",
    systemPrompt: "You implement configuration modules. Keep them minimal."
  },
  {
    agentId: "validation-engineer",
    role: "Validation Engineer",
    description: "Owns input-validation code",
    systemPrompt: "You implement validation modules. Keep them minimal."
  },
  {
    agentId: "health-engineer",
    role: "Health Engineer",
    description: "Owns health-check code",
    systemPrompt: "You implement health-check modules. Keep them minimal."
  }
];

// Populated as soon as known, so fail()/dumpDiagnostics() can use whatever
// is available at the point of failure.
const repoDir = REPO_DIR;
let runId;
let mcpClient;
let agenticServer;
/** {taskId, workerId}[] -- populated by whichever phase learns about workers, for dumpDiagnostics. */
let diagTasks = [];
/** taskId -> { workerId, worktreePath, file, agentId, verifyCommand, lastState, unchangedPolls, sinceSeq, processed, failed, filesChanged } (build phase only). */
const workers = new Map();

function log(...args) {
  console.log(`[demo-run ${new Date().toISOString()}]`, ...args);
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

function capText(text, maxChars = DIFF_CHAR_CAP) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(truncated; ${text.length - maxChars} more chars)...`;
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
  console.error("\n[demo-run] ---- diagnostics ----");
  if (repoDir && runId) {
    const rd = runDirFor(repoDir, runId);

    for (const { taskId, workerId } of diagTasks) {
      console.error(`[demo-run] -- task ${taskId} (worker ${workerId ?? "<none>"}) --`);
      if (workerId) {
        console.error(`[demo-run] meta.json (${workerMetaPath(workerId)}):`);
        console.error(await tailFile(workerMetaPath(workerId)));
        try {
          const res = await callTool("stream_worker_log", { workerId, sinceSeq: 0 });
          console.error(`[demo-run] log events: ${JSON.stringify(res.data, null, 2).slice(-3000)}`);
        } catch (err) {
          console.error(`<could not fetch worker log: ${err.message}>`);
        }
      }
    }

    try {
      const specialists = await callTool("specialist", { action: "list" });
      console.error(`[demo-run] specialist list: ${JSON.stringify(specialists.data)}`);
    } catch (err) {
      console.error(`<could not list specialists: ${err.message}>`);
    }

    const serveLog = path.join(rd, "opencode-serve.log");
    console.error(`[demo-run] opencode-serve.log tail (${serveLog}):`);
    console.error(await tailFile(serveLog));

    const eventsLog = path.join(rd, "events.jsonl");
    console.error(`[demo-run] run events.jsonl tail (${eventsLog}):`);
    console.error(await tailFile(eventsLog));
  }
  console.error(`[demo-run] scratch dir PRESERVED for inspection: ${SCRATCH_ROOT}`);
  console.error("[demo-run] ---- end diagnostics ----\n");
}

async function fail(message) {
  console.error(`\n[demo-run] FAILURE: ${message}`);
  await dumpDiagnostics().catch((err) => console.error(`[demo-run] diagnostics dump itself failed: ${err.message}`));
  process.exit(1);
}

/** Reads <repoDir>/.cohort/runs/<runId>/server.json and force-kills that pid, best-effort. */
async function killServeForRun(id) {
  try {
    const serverJsonPath = path.join(runDirFor(repoDir, id), "server.json");
    const serverJson = JSON.parse(await readFile(serverJsonPath, "utf8"));
    log(`killing spawned opencode serve (pid ${serverJson.pid}, run ${id})...`);
    run("taskkill", ["/PID", String(serverJson.pid), "/T", "/F"], REPO_ROOT, { allowFail: true, stdio: "ignore" });
  } catch (err) {
    log(`no server.json to clean up for run ${id} (${err.message})`);
  }
}

/** Best-effort: kill opencode serve for every run this scratch project has ever created (used by 'reset'). */
async function killAllServesUnderProject() {
  const runsDir = path.join(repoDir, ".cohort", "runs");
  let entries;
  try {
    entries = await readdir(runsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    await killServeForRun(entry);
  }
}

async function connectServer() {
  const { createAgenticMcpServer } = await import("../packages/core/dist/mcp/server.js");
  agenticServer = await createAgenticMcpServer({ projectDir: repoDir, platformConfigDir: PLATFORM_CONFIG_DIR });

  runId = JSON.parse(await readFile(path.join(repoDir, ".cohort", "current-run.json"), "utf8")).runId;
  log(`runId: ${runId}`);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await agenticServer.server.connect(serverTransport);
  mcpClient = new Client({ name: "demo-run-client", version: "0.0.0" });
  await mcpClient.connect(clientTransport);
}

async function closeServer() {
  await mcpClient?.close().catch(() => {});
  await agenticServer?.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Phase: reset
// ---------------------------------------------------------------------------

async function phaseReset() {
  log(`reset: wiping scratch root ${SCRATCH_ROOT}`);
  await killAllServesUnderProject().catch((err) => log(`killAllServesUnderProject failed (non-fatal): ${err.message}`));
  await sleep(500); // let the OS release file handles before rm (Windows worktree-handle race; see smoke.mjs)
  await rm(SCRATCH_ROOT, { recursive: true, force: true });
  log("reset done");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Phase: build
// ---------------------------------------------------------------------------

async function phaseBuild() {
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  log(`scratch repo: ${repoDir}`);
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "demo-run@cohort.local"], repoDir);
  git(["config", "user.name", "Cohort Demo Run"], repoDir);
  git(["config", "core.autocrlf", "false"], repoDir);

  // Trivial package.json: "typecheck" and "test" both exit 0 -- so
  // config/orchestrator.yaml's "full" check suite (typecheck + test), which
  // integrate_batch runs as the regression check, passes against this toy
  // repo regardless of what the workers add.
  const pkg = {
    name: "agentic-demo-toy",
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

  await connectServer();

  // -- 1. plan_submit: dynamic org + 3-domain plan -----------------------------
  log("plan_submit (3 domains, org chart, 3 disjoint dependency-free tasks)...");
  const planned = await callTool("plan_submit", {
    objective: OBJECTIVE,
    domains: DOMAINS,
    orgChart: ORG_CHART,
    tasks: TASKS.map((t) => ({
      id: t.id,
      title: t.title,
      prompt: t.prompt,
      dependsOn: [],
      fileOwnership: t.fileOwnership,
      domain: t.domain
    }))
  });
  if (planned.isError || !planned.data?.valid) {
    await fail(`plan_submit failed (org validation should have passed -- domains match every org node/task): ${JSON.stringify(planned.data)}`);
    return;
  }
  log(`plan submitted: planId=${planned.data.planId} taskCount=${planned.data.taskCount} valid=${planned.data.valid}`);

  // -- 2. specialist(generate) x3 ------------------------------------------------
  for (const spec of SPECIALISTS) {
    log(`specialist(generate) agentId=${spec.agentId}...`);
    const generated = await callTool("specialist", { action: "generate", ...spec });
    if (generated.isError || !generated.data?.path) {
      await fail(`specialist(generate, ${spec.agentId}) failed: ${JSON.stringify(generated.data)}`);
      return;
    }
    if (!(await pathExists(generated.data.path))) {
      await fail(`specialist file does not exist on disk: ${generated.data.path}`);
      return;
    }
    log(`  -> ${generated.data.path}`);
  }
  log("all 3 specialists generated");

  // -- 3. next_batch ---------------------------------------------------------------
  log("next_batch...");
  const batch = await callTool("next_batch", {});
  if (batch.isError || !batch.data?.batchId || (batch.data.tasks ?? []).length !== TASKS.length) {
    await fail(`next_batch did not return all ${TASKS.length} disjoint tasks as ready: ${JSON.stringify(batch.data)}`);
    return;
  }
  const batchId = batch.data.batchId;
  log(`batchId=${batchId}, ready tasks: ${batch.data.tasks.map((t) => t.id).join(", ")}`);

  // -- 4. spawn one worker per ready task, AS its specialist -----------------------
  for (const t of TASKS) {
    log(`spawn_worker taskId=${t.id} agentId=${t.agentId} (model: config/models.yaml routing.default = auto:free)...`);
    const spawned = await callTool("spawn_worker", { taskId: t.id, prompt: t.prompt, agentId: t.agentId });
    if (spawned.isError) {
      await fail(`spawn_worker(${t.id}) returned isError: ${JSON.stringify(spawned.data)}`);
      return;
    }
    workers.set(t.id, {
      workerId: spawned.data.workerId,
      worktreePath: spawned.data.worktreePath,
      file: t.file,
      agentId: t.agentId,
      verifyCommand: `node -e "process.exit(require('fs').existsSync('${t.file}')?0:1)"`,
      lastState: spawned.data.state,
      unchangedPolls: 0,
      sinceSeq: 0,
      processed: false,
      failed: false,
      filesChanged: []
    });
    diagTasks.push({ taskId: t.id, workerId: spawned.data.workerId });
    log(`  -> workerId=${spawned.data.workerId} worktree=${spawned.data.worktreePath}`);
  }

  // -- 5. poll worker_status; collect+verify each worker as it completes ----------
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
        log(`  task=${taskId} looks stuck in '${info.state}' for ${(w.unchangedPolls * POLL_MS) / 1000}s; streaming its log...`);
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
        w.filesChanged = collected.data?.filesChanged ?? [];
        log(`  collect: filesChanged=${JSON.stringify(w.filesChanged)}`);
        const verified = await callTool("verify_worker", { workerId: w.workerId, command: w.verifyCommand });
        w.processed = true;
        w.lastState = verified.data?.state ?? w.lastState;
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
          await callTool("abort_worker", { workerId: w.workerId, reason: "demo-run build exceeded 10 minute wait" }).catch(() => {});
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
    log(`WARNING: task(s) failed to complete+verify: ${failedTasks.join(", ")} -- writing handoff.json anyway for diagnostics`);
  } else {
    log("all workers completed and verified (running as their specialist agentId)");
  }

  // -- 6. handoff.json: real per-task diffs for the orchestrator's reviewer subagents --
  const handoffTasks = [];
  for (const [taskId, w] of workers) {
    const diffResult = git(["diff", `${BASE_BRANCH}..HEAD`], w.worktreePath, { allowFail: true });
    const diff = diffResult.status === 0 ? capText(diffResult.stdout) : `<diff failed: ${diffResult.stderr ?? ""}>`;
    handoffTasks.push({
      taskId,
      workerId: w.workerId,
      file: w.file,
      worktreePath: w.worktreePath,
      state: w.lastState,
      verified: !w.failed,
      filesChanged: w.filesChanged,
      diff
    });
  }
  const handoff = { runId, batchId, tasks: handoffTasks };
  await writeFile(HANDOFF_PATH, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  log(`handoff written: ${HANDOFF_PATH}`);

  const verifiedCount = handoffTasks.filter((t) => t.verified).length;
  console.log(`\n[demo-run] PHASE BUILD DONE — handoff.json written, ${verifiedCount} workers verified\n`);

  if (verifiedCount !== TASKS.length) {
    await dumpDiagnostics().catch(() => {});
    await closeServer();
    console.error(`[demo-run] scratch dir kept for inspection: ${SCRATCH_ROOT}`);
    process.exit(1);
    return;
  }

  await closeServer();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Phase: integrate
// ---------------------------------------------------------------------------

async function phaseIntegrate() {
  if (!(await pathExists(HANDOFF_PATH))) {
    console.error(`[demo-run] FAILURE: handoff.json not found at ${HANDOFF_PATH} -- run 'node scripts/demo-run.mjs build' first.`);
    process.exit(1);
    return;
  }
  if (!(await pathExists(VERDICTS_PATH))) {
    console.error(
      `[demo-run] FAILURE: verdicts.json not found at ${VERDICTS_PATH} -- write reviewer verdicts there ` +
        `(array of {taskId, reviewerId, verdict, findings, summary}) before running 'integrate'.`
    );
    process.exit(1);
    return;
  }

  const handoff = JSON.parse(await readFile(HANDOFF_PATH, "utf8"));
  const verdicts = JSON.parse(await readFile(VERDICTS_PATH, "utf8"));

  if (!handoff.runId || !handoff.batchId || !Array.isArray(handoff.tasks)) {
    console.error(`[demo-run] FAILURE: handoff.json is malformed (expected {runId, batchId, tasks[]}): ${JSON.stringify(handoff)}`);
    process.exit(1);
    return;
  }
  if (!Array.isArray(verdicts)) {
    console.error(`[demo-run] FAILURE: verdicts.json is malformed (expected an array): ${JSON.stringify(verdicts)}`);
    process.exit(1);
    return;
  }

  diagTasks = handoff.tasks.map((t) => ({ taskId: t.taskId, workerId: t.workerId }));

  await connectServer();

  if (runId !== handoff.runId) {
    await fail(
      `runId mismatch: current-run.json says '${runId}' but handoff.json says '${handoff.runId}' -- the project ` +
        "dir was reset/reused between phases. Re-run 'build' first."
    );
    return;
  }
  log(`reattached to run ${runId} (batchId=${handoff.batchId})`);

  // -- 1. record every real reviewer verdict --------------------------------------
  for (const v of verdicts) {
    log(`review_verdict(record) taskId=${v.taskId} reviewerId=${v.reviewerId} verdict=${v.verdict}...`);
    const recorded = await callTool("review_verdict", {
      action: "record",
      taskId: v.taskId,
      reviewerId: v.reviewerId,
      verdict: v.verdict,
      findings: v.findings ?? [],
      summary: v.summary
    });
    if (recorded.isError) {
      await fail(`review_verdict(record) failed for taskId=${v.taskId} reviewerId=${v.reviewerId}: ${JSON.stringify(recorded.data)}`);
      return;
    }
  }

  // -- 2. get + blocking roll-up per task ------------------------------------------
  const taskIds = [...new Set(handoff.tasks.map((t) => t.taskId))];
  const blockedTaskIds = [];
  const verdictSummaries = {};
  for (const taskId of taskIds) {
    const got = await callTool("review_verdict", { action: "get", taskId });
    if (got.isError) {
      await fail(`review_verdict(get) failed for taskId=${taskId}: ${JSON.stringify(got.data)}`);
      return;
    }
    verdictSummaries[taskId] = got.data.summary;
    log(`  task=${taskId}: worst=${got.data.summary.worst} blocking=${got.data.summary.blocking}`);
    if (got.data.summary.blocking) blockedTaskIds.push(taskId);
  }

  // -- 3. replan_record + exclude any blocked task from the merge -----------------
  if (blockedTaskIds.length > 0) {
    log(`BLOCKED (will NOT be integrated): ${blockedTaskIds.join(", ")}`);
    const replanned = await callTool("replan_record", {
      reason: `Reviewer verdict blocking integration for: ${blockedTaskIds.join(", ")}`,
      affectedTaskIds: blockedTaskIds
    });
    if (replanned.isError) {
      await fail(`replan_record failed: ${JSON.stringify(replanned.data)}`);
      return;
    }
    log(`replan_record: iteration=${replanned.data.iteration} escalate=${replanned.data.escalate}`);

    // integrate_batch only merges tasks whose worker is 'verified'; discarding
    // a blocked task's worker first removes it from that set (it shows up in
    // integrate_batch's `notVerified` instead) without touching the other
    // (non-blocked) tasks in the same batch.
    for (const taskId of blockedTaskIds) {
      const t = handoff.tasks.find((x) => x.taskId === taskId);
      if (!t) continue;
      log(`  excluding blocked task ${taskId} from integration: finalize_worker(discard) workerId=${t.workerId}...`);
      const discarded = await callTool("finalize_worker", { workerId: t.workerId, action: "discard" });
      if (discarded.isError) {
        await fail(`finalize_worker(discard) failed for blocked task ${taskId} (workerId=${t.workerId}): ${JSON.stringify(discarded.data)}`);
        return;
      }
    }
  } else {
    log("no blocking verdicts -- all tasks eligible for integration");
  }

  // -- 4. integrate_batch -----------------------------------------------------------
  log(`integrate_batch batchId=${handoff.batchId} regressionSuite=${REGRESSION_SUITE}...`);
  const integrated = await callTool("integrate_batch", { batchId: handoff.batchId, regressionSuite: REGRESSION_SUITE });
  if (integrated.isError || !integrated.data?.allMerged || !integrated.data?.allPassed) {
    await fail(`integrate_batch did not report allMerged+allPassed for the non-blocked set: ${JSON.stringify(integrated.data)}`);
    return;
  }
  const integrationBranch = integrated.data.integrationBranch;
  log(`integrated onto '${integrationBranch}': merges=${JSON.stringify(integrated.data.merges)} notVerified=${JSON.stringify(integrated.data.notVerified)}`);
  log(`regression (${REGRESSION_SUITE}) passed=${integrated.data.regressionCheck?.passed}`);

  // Assert directly on the integration branch (never trust self-report) --
  // only for tasks integrate_batch actually reports as merged.
  const mergedTaskIds = new Set((integrated.data.merges ?? []).map((m) => m.taskId));
  for (const t of handoff.tasks) {
    if (!mergedTaskIds.has(t.taskId)) continue;
    const check = git(["cat-file", "-e", `${integrationBranch}:${t.file}`], repoDir, { allowFail: true });
    if (check.status !== 0) {
      await fail(`${t.file} not found on integration branch '${integrationBranch}' for merged task ${t.taskId} (git cat-file -e failed)`);
      return;
    }
  }
  log(`assertions passed: merged files present on integration branch (${[...mergedTaskIds].join(", ") || "none"})`);

  // -- 5. specialist(retire) x3 ------------------------------------------------------
  const specialistPaths = {};
  for (const spec of SPECIALISTS) {
    specialistPaths[spec.agentId] = path.join(repoDir, ".opencode", "agent", `${spec.agentId}.md`);
  }
  for (const spec of SPECIALISTS) {
    log(`specialist(retire) agentId=${spec.agentId}...`);
    const retired = await callTool("specialist", { action: "retire", agentId: spec.agentId });
    if (retired.isError || retired.data?.removed !== true) {
      await fail(`specialist(retire, ${spec.agentId}) did not report removed:true: ${JSON.stringify(retired.data)}`);
      return;
    }
    if (await pathExists(specialistPaths[spec.agentId])) {
      await fail(`specialist file still exists after retire: ${specialistPaths[spec.agentId]}`);
      return;
    }
  }
  log("all 3 specialists retired; .md files removed from disk");

  // -- 6. run_report -------------------------------------------------------------------
  log("run_report...");
  const reported = await callTool("run_report", {});
  if (reported.isError) {
    await fail(`run_report returned isError: ${JSON.stringify(reported.data)}`);
    return;
  }
  const { summary, reportPath, markdown } = reported.data ?? {};
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
  log(`run_report verified: tasks.total=${summary?.tasks?.total} workers.total=${summary?.workers?.total} reportPath=${reportPath}`);
  log("run_report markdown contains both mermaid fences (gantt timeline + graph TD task DAG) and the Model & Cost Usage table");

  // -- 7. final report ------------------------------------------------------------------
  const integrationSha = git(["rev-parse", integrationBranch], repoDir).stdout.trim();
  const finalStatus = await callTool("worker_status", {}).catch(() => undefined);
  const totalCost = finalStatus?.data?.budget?.committedUsd ?? 0;

  const perTaskModels = {};
  const perTaskStates = {};
  for (const t of handoff.tasks) {
    const meta = await readWorkerMetaJson(t.workerId);
    perTaskModels[t.taskId] = meta.model ?? "<unknown>";
    perTaskStates[t.taskId] = meta.state ?? "<unknown>";
  }

  if (totalCost > 0.05) {
    await fail(`total committed cost $${totalCost} is not ~$0 -- a non-free model may have been used`);
    return;
  }

  console.log("\n[demo-run] ==== FINAL REPORT ====");
  console.log(`generated org: domains=${DOMAINS.map((d) => d.id).join(",")} orgChart root=${ORG_CHART.root.role}`);
  console.log(`specialists generated+retired: ${SPECIALISTS.map((s) => s.agentId).join(", ")}`);
  console.log("per-task results:");
  for (const t of handoff.tasks) {
    console.log(`  ${t.taskId}: workerId=${t.workerId} state=${perTaskStates[t.taskId]} model=${perTaskModels[t.taskId]}`);
  }
  console.log("recorded reviewer verdicts:");
  for (const v of verdicts) {
    console.log(`  ${v.taskId}: reviewerId=${v.reviewerId} verdict=${v.verdict}`);
  }
  console.log(`blocked tasks (excluded from integration, replanned): ${blockedTaskIds.join(", ") || "none"}`);
  console.log(`integration branch: ${integrationBranch} @ ${integrationSha}`);
  console.log(`files merged: ${handoff.tasks.filter((t) => mergedTaskIds.has(t.taskId)).map((t) => t.file).join(", ") || "none"}`);
  console.log(`total committed cost: $${totalCost}`);
  console.log(`regression suite '${REGRESSION_SUITE}': passed=${integrated.data.regressionCheck?.passed}`);
  console.log(`report: ${reportPath}`);
  console.log("[demo-run] PHASE INTEGRATE DONE — ACCEPTANCE PASSED");
  console.log("[demo-run] ==== END FINAL REPORT ====\n");

  // -- 8. cleanup: kill opencode serve, KEEP the scratch dir (orchestrator needs report.md) --
  await closeServer();
  await killServeForRun(runId);

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const phase = process.argv[2];
  if (phase !== "build" && phase !== "integrate" && phase !== "reset") {
    console.error("Usage: node scripts/demo-run.mjs <build|integrate|reset>");
    process.exit(1);
    return;
  }

  if (phase === "reset") {
    await phaseReset();
    return;
  }

  log("building packages/core (npm run build)...");
  run("npm", ["run", "build"], REPO_ROOT, { stdio: "inherit", shell: true });
  log("build ok");

  if (phase === "build") {
    await phaseBuild();
  } else {
    await phaseIntegrate();
  }
}

main().catch(async (err) => {
  console.error(`[demo-run] unexpected error: ${err.stack ?? err.message}`);
  await dumpDiagnostics().catch(() => {});
  process.exit(1);
});
