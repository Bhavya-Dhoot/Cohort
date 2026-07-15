#!/usr/bin/env node
/**
 * scripts/m3-accept.mjs — M3 acceptance test for Agentic OS.
 *
 * Proves the dynamic-org / specialist / reviewer pipeline end-to-end with
 * REAL OpenCode workers on free models, driven entirely through the real MCP
 * tool surface: plan_submit (with domains + orgChart) -> specialist(generate)
 * x2 -> next_batch -> spawn_worker x2 (each pinned to its specialist's
 * agentId) -> worker_status polling -> collect_worker/verify_worker per
 * worker -> review_verdict(record/get) incl. the anti-rubber-stamp guard ->
 * integrate_batch -> specialist(retire) x2.
 *
 * Structurally a sibling of scripts/m2-accept.mjs (same build-then-
 * scratch-repo-then-MCP-client shape, same poll pattern, same Windows
 * post-merge worktree-handle race handling, same "keep the scratch dir on
 * failure" diagnostics contract) extended for M3's org/specialist/review
 * surface. Two disjoint-ownership tasks (not three, like M2) is enough to
 * prove the DAG/batch machinery again while keeping the focus on what's new.
 *
 * Usage: npm run m3-accept
 * Env:   M3_SCRATCH_DIR  optional override for the scratch repo/worktrees
 *                          root; defaults under os.tmpdir() (see
 *                          smoke.mjs's SMOKE_SCRATCH_DIR doc for why: a
 *                          scratch git repo/worktrees must never nest inside
 *                          this platform repo itself).
 *
 * Notes verified against source, not assumed:
 *   - plan_submit's `domains`/`orgChart` are optional M2-schema fields
 *     reserved for M3 (plan/schema.ts) — validateOrgReferences runs before
 *     any persistence and fails closed (isError) if an org node or task
 *     references a domain id not declared in `domains`.
 *   - specialist(action:'generate') writes
 *     <projectDir>/.opencode/agent/<agentId>.md with config.agents.
 *     default_permission.deny always merged in as a permission floor
 *     (agents.yaml here: "git push*", "npm publish*", ...) — this script
 *     asserts that floor landed in the rendered file rather than assuming it.
 *   - spawn_worker's `agentId` flows through supervisor.spawn ->
 *     client.createSession's `agent` field (worker/index.ts, opencode-client/
 *     client.ts) — passing the specialist's agentId here is what makes the
 *     worker run "as" that specialist, per the M3 task brief.
 *   - review_verdict's anti-rubber-stamp rule (review/schema.ts's
 *     ReviewVerdictInputSchema.superRefine) rejects a non-'pass' verdict with
 *     zero findings at the schema layer — recordVerdict throws, which
 *     runTool's catch-all turns into isError:true. This script records that
 *     rejection as a PASS condition (the guard IS the thing being proven),
 *     not a failure.
 *   - config/models.yaml's routing.default is already "auto:free" -- no
 *     explicit `model` is passed to spawn_worker anywhere in this script;
 *     resolved once per MCP server instance (memoized in ctx.cachedFreeModel).
 *   - No in-script retry-with-different-model loop is implemented, per
 *     ORCHESTRATION.md's "root-cause before retrying" / "do NOT loop"
 *     doctrine (same stance m2-accept.mjs documents) — on a model-caused
 *     failure this script fails fast with full diagnostics.
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
const SCRATCH_BASE_DIR = process.env.M3_SCRATCH_DIR ?? path.join(os.tmpdir(), "agentic-m3-accept");

const POLL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const REGRESSION_SUITE = "full"; // config/orchestrator.yaml checks.suites.full = typecheck + test

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

const OBJECTIVE = "Add a config module and a health-check module";

// Two domains the dynamic org is generated around.
const DOMAINS = [
  { id: "config", name: "Configuration" },
  { id: "health", name: "Health Check" }
];

// CEO -> EM -> two domain leads, each with one specialist + one reviewer.
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
      "Create src/config.js exporting a function getConfig() that returns {ok:true}. Only create that file. " +
      "Then run `git add src/config.js` and `git commit -m \"add: src/config.js\"` to commit it."
  },
  {
    id: "feat-health",
    title: "Add src/health.js",
    file: "src/health.js",
    domain: "health",
    agentId: "health-engineer",
    fileOwnership: ["src/health.js"],
    prompt:
      "Create src/health.js exporting a function health() that returns \"ok\". Only create that file. " +
      "Then run `git add src/health.js` and `git commit -m \"add: src/health.js\"` to commit it."
  }
];

// The two specialists generated for this run, one per domain.
const SPECIALISTS = [
  {
    agentId: "config-engineer",
    role: "Config Engineer",
    description: "Owns configuration code",
    systemPrompt: "You implement configuration modules. Keep them minimal."
  },
  {
    agentId: "health-engineer",
    role: "Health Engineer",
    description: "Owns health-check code",
    systemPrompt: "You implement health-check modules. Keep them minimal."
  }
];

// One reviewer verdict per task, both 'pass' (no findings required for pass).
const REVIEWS = [
  { taskId: "feat-config", reviewerId: "architecture", verdict: "pass", findings: [], summary: "clean config module" },
  { taskId: "feat-health", reviewerId: "testing", verdict: "pass", findings: [], summary: "adequate" }
];

// A sample entry from config/agents.yaml's default_permission.deny -- every
// generated specialist file must carry this floor regardless of its own
// permission spec.
const DENY_FLOOR_SAMPLE = "git push*";

// Populated as soon as known, so fail()/dumpDiagnostics() can use whatever
// is available at the point of failure.
let scratchRoot;
let repoDir;
let runId;
let mcpClient;
let agenticServer;
/** taskId -> { workerId, verifyCommand, file, agentId, lastState, unchangedPolls, sinceSeq, processed, failed } */
const workers = new Map();

function log(...args) {
  console.log(`[m3-accept ${new Date().toISOString()}]`, ...args);
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
  console.error("\n[m3-accept] ---- diagnostics ----");
  if (repoDir && runId) {
    const rd = runDirFor(repoDir, runId);

    for (const [taskId, w] of workers) {
      console.error(`[m3-accept] -- task ${taskId} (worker ${w.workerId ?? "<none>"}) --`);
      if (w.workerId) {
        console.error(`[m3-accept] meta.json (${workerMetaPath(w.workerId)}):`);
        console.error(await tailFile(workerMetaPath(w.workerId)));
        try {
          const res = await callTool("stream_worker_log", { workerId: w.workerId, sinceSeq: 0 });
          console.error(`[m3-accept] log events: ${JSON.stringify(res.data, null, 2).slice(-3000)}`);
        } catch (err) {
          console.error(`<could not fetch worker log: ${err.message}>`);
        }
      }
    }

    try {
      const specialists = await callTool("specialist", { action: "list" });
      console.error(`[m3-accept] specialist list: ${JSON.stringify(specialists.data)}`);
    } catch (err) {
      console.error(`<could not list specialists: ${err.message}>`);
    }

    const serveLog = path.join(rd, "opencode-serve.log");
    console.error(`[m3-accept] opencode-serve.log tail (${serveLog}):`);
    console.error(await tailFile(serveLog));

    const eventsLog = path.join(rd, "events.jsonl");
    console.error(`[m3-accept] run events.jsonl tail (${eventsLog}):`);
    console.error(await tailFile(eventsLog));
  }
  if (scratchRoot) {
    console.error(`[m3-accept] scratch dir PRESERVED for inspection: ${scratchRoot}`);
  }
  console.error("[m3-accept] ---- end diagnostics ----\n");
}

async function fail(message) {
  console.error(`\n[m3-accept] FAILURE: ${message}`);
  await dumpDiagnostics().catch((err) => console.error(`[m3-accept] diagnostics dump itself failed: ${err.message}`));
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
  git(["config", "user.email", "m3-accept@agentic-os.local"], repoDir);
  git(["config", "user.name", "Agentic OS M3 Accept"], repoDir);
  git(["config", "core.autocrlf", "false"], repoDir);

  // Trivial package.json: "typecheck" and "test" both exit 0 -- so
  // config/orchestrator.yaml's "full" check suite (typecheck + test), which
  // integrate_batch runs as the regression check, passes against this toy
  // repo regardless of what the workers add.
  const pkg = {
    name: "agentic-m3-toy",
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

  runId = JSON.parse(await readFile(path.join(repoDir, ".agentic-os", "current-run.json"), "utf8")).runId;
  log(`runId: ${runId}`);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await agenticServer.server.connect(serverTransport);
  mcpClient = new Client({ name: "m3-accept-client", version: "0.0.0" });
  await mcpClient.connect(clientTransport);

  // -- 1. plan_submit: dynamic org + two-domain plan --------------------------
  log("plan_submit (2 domains, org chart, 2 disjoint dependency-free tasks)...");
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

  // -- 2. specialist(generate) x2 ----------------------------------------------
  const specialistPaths = {};
  for (const spec of SPECIALISTS) {
    log(`specialist(generate) agentId=${spec.agentId}...`);
    const generated = await callTool("specialist", { action: "generate", ...spec });
    if (generated.isError || !generated.data?.path) {
      await fail(`specialist(generate, ${spec.agentId}) failed: ${JSON.stringify(generated.data)}`);
      return;
    }
    specialistPaths[spec.agentId] = generated.data.path;
    log(`  -> ${generated.data.path}`);

    const expectedPath = path.join(repoDir, ".opencode", "agent", `${spec.agentId}.md`);
    if (path.resolve(generated.data.path) !== path.resolve(expectedPath)) {
      await fail(`specialist(generate, ${spec.agentId}) returned unexpected path: ${generated.data.path} (expected ${expectedPath})`);
      return;
    }
    if (!(await pathExists(expectedPath))) {
      await fail(`specialist file does not exist on disk: ${expectedPath}`);
      return;
    }
    const content = await readFile(expectedPath, "utf8");
    if (!content.includes(DENY_FLOOR_SAMPLE)) {
      await fail(`specialist file ${expectedPath} missing deny-floor entry '${DENY_FLOOR_SAMPLE}': ${content}`);
      return;
    }
  }
  log(`both specialists generated with deny-floor entry '${DENY_FLOOR_SAMPLE}' present`);

  const listed = await callTool("specialist", { action: "list" });
  if (listed.isError || (listed.data?.specialists ?? []).length !== 2) {
    await fail(`specialist(list) did not report 2 specialists: ${JSON.stringify(listed.data)}`);
    return;
  }
  log(`specialist(list) confirms 2 active: ${listed.data.specialists.map((s) => s.agentId).join(", ")}`);

  // -- 3. next_batch -------------------------------------------------------------
  log("next_batch...");
  const batch = await callTool("next_batch", {});
  if (batch.isError || !batch.data?.batchId || (batch.data.tasks ?? []).length !== TASKS.length) {
    await fail(`next_batch did not return all ${TASKS.length} disjoint tasks as ready: ${JSON.stringify(batch.data)}`);
    return;
  }
  const batchId = batch.data.batchId;
  log(`batchId=${batchId}, ready tasks: ${batch.data.tasks.map((t) => t.id).join(", ")}`);

  // -- 4. spawn one worker per ready task, AS its specialist ---------------------
  for (const t of TASKS) {
    log(`spawn_worker taskId=${t.id} agentId=${t.agentId} (model: config/models.yaml routing.default = auto:free)...`);
    const spawned = await callTool("spawn_worker", { taskId: t.id, prompt: t.prompt, agentId: t.agentId });
    if (spawned.isError) {
      await fail(`spawn_worker(${t.id}) returned isError: ${JSON.stringify(spawned.data)}`);
      return;
    }
    workers.set(t.id, {
      workerId: spawned.data.workerId,
      file: t.file,
      agentId: t.agentId,
      verifyCommand: `node -e "process.exit(require('fs').existsSync('${t.file}')?0:1)"`,
      lastState: spawned.data.state,
      unchangedPolls: 0,
      sinceSeq: 0,
      processed: false,
      failed: false
    });
    log(`  -> workerId=${spawned.data.workerId} worktree=${spawned.data.worktreePath}`);
  }

  // -- 5. poll worker_status; collect+verify each worker as it completes --------
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
          await callTool("abort_worker", { workerId: w.workerId, reason: "m3-accept exceeded 10 minute wait" }).catch(() => {});
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
  log("both workers completed and verified (running as their specialist agentId)");

  // -- 6. reviewer verdicts: record x2, get + blocking roll-up, anti-rubber-stamp guard --
  for (const rv of REVIEWS) {
    log(`review_verdict(record) taskId=${rv.taskId} reviewerId=${rv.reviewerId} verdict=${rv.verdict}...`);
    const recorded = await callTool("review_verdict", { action: "record", ...rv });
    if (recorded.isError) {
      await fail(`review_verdict(record) failed for taskId=${rv.taskId}: ${JSON.stringify(recorded.data)}`);
      return;
    }
  }

  const got = await callTool("review_verdict", { action: "get", taskId: "feat-config" });
  if (got.isError || got.data?.summary?.blocking !== false) {
    await fail(`review_verdict(get, feat-config) did not report summary.blocking === false: ${JSON.stringify(got.data)}`);
    return;
  }
  log(`review_verdict(get, feat-config): worst=${got.data.summary.worst} blocking=${got.data.summary.blocking}`);

  log("proving anti-rubber-stamp guard: review_verdict(record, block, findings:[]) must be rejected...");
  const badVerdict = await callTool("review_verdict", {
    action: "record",
    taskId: "feat-health",
    reviewerId: "security",
    verdict: "block",
    findings: []
  });
  if (!badVerdict.isError) {
    await fail(`review_verdict(record) with verdict='block' and empty findings should have returned isError, but succeeded: ${JSON.stringify(badVerdict.data)}`);
    return;
  }
  log(`anti-rubber-stamp guard confirmed: empty-findings block verdict correctly rejected (isError=true): ${JSON.stringify(badVerdict.data)}`);

  // -- 7. integrate_batch ---------------------------------------------------------
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
  log("assertions passed: both files present on integration branch");

  // -- 8. specialist(retire) x2 ---------------------------------------------------
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
  log("both specialists retired; .md files removed from disk");

  // -- 9. final report ------------------------------------------------------------
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

  console.log("\n[m3-accept] ==== FINAL REPORT ====");
  console.log(`org validated: domains=${DOMAINS.map((d) => d.id).join(",")} orgChart root=${ORG_CHART.root.role}`);
  console.log("specialists generated+retired:");
  for (const spec of SPECIALISTS) {
    console.log(`  ${spec.agentId}: generated -> ${specialistPaths[spec.agentId]}, retired -> removed:true`);
  }
  console.log("per-task results:");
  for (const [taskId, w] of workers) {
    console.log(`  ${taskId}: workerId=${w.workerId} agentId=${w.agentId} state=${w.lastState} model=${perTaskModels[taskId]} failed=${w.failed}`);
  }
  console.log("reviewer verdicts recorded:");
  for (const rv of REVIEWS) {
    console.log(`  ${rv.taskId}: reviewerId=${rv.reviewerId} verdict=${rv.verdict}`);
  }
  console.log(`  feat-config summary: worst=${got.data.summary.worst} blocking=${got.data.summary.blocking}`);
  console.log(`  anti-rubber-stamp guard: block verdict with empty findings correctly rejected (isError=true)`);
  console.log(`total committed cost: $${totalCost}`);
  console.log(`integration branch: ${integrationBranch} @ ${integrationSha}`);
  console.log(`files merged: ${TASKS.map((t) => t.file).join(", ")}`);
  console.log(`regression suite '${REGRESSION_SUITE}': passed=${integrated.data.regressionCheck?.passed}`);
  console.log("[m3-accept] ==== ACCEPTANCE PASSED ====\n");

  // -- 10. cleanup (success only) ------------------------------------------------
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
  console.error(`[m3-accept] unexpected error: ${err.stack ?? err.message}`);
  await dumpDiagnostics().catch(() => {});
  process.exit(1);
});
