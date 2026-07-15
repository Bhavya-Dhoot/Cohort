#!/usr/bin/env node
/**
 * scripts/smoke.mjs — full-stack E2E smoke test for Agentic OS.
 *
 * Builds packages/core, spins up a throwaway scratch git repo, drives the
 * REAL MCP tool surface (spawn_worker -> worker_status/stream_worker_log
 * polling -> verify_worker -> finalize_worker merge) against a REAL
 * `opencode serve`, and asserts the merge landed on the scratch repo's main
 * branch with the expected file content.
 *
 * Usage: npm run smoke
 * Env:   SMOKE_MODEL        optional "provider/model" override passed to
 *                            spawn_worker; omitted -> config/models.yaml's
 *                            routing.default is used instead.
 *        SMOKE_SCRATCH_DIR  optional override for the root directory the
 *                            scratch repo/worktrees are created under;
 *                            defaults to a directory under the OS temp dir
 *                            so a smoke run never creates a nested git repo
 *                            (or leftover worktree dirs) inside the platform
 *                            repo itself -- see worktree/guard.ts's
 *                            assertIsWorktreeRoot docstring for the class of
 *                            bug that kind of nesting caused in production.
 *
 * Notes on where state actually lives (verified against
 * packages/core/src/mcp/server.ts and worker/index.ts, not assumed):
 *   - createAgenticMcpServer is NOT re-exported from dist/index.js (only
 *     the library modules are); it's imported from dist/mcp/server.js.
 *   - `opencode serve`'s server.json/log file live under
 *     <projectDir>/.agentic-os/runs/<runId>/{server.json,opencode-serve.log}
 *     (ensureServer is called with stateDir = the run dir), not directly
 *     under <projectDir>/.agentic-os/.
 *   - Worktrees live at <projectDir>/../<projectDirName>-agentic-worktrees.
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
// Scratch workspaces live OUTSIDE the platform repo by default -- a git repo
// (and worktrees) nested inside REPO_ROOT is exactly the shape of directory
// layout that caused a dead worktree to be mistaken for an enclosing repo in
// production (see worktree/guard.ts). SMOKE_SCRATCH_DIR overrides the root
// if a specific location is needed.
const SCRATCH_BASE_DIR = process.env.SMOKE_SCRATCH_DIR ?? path.join(os.tmpdir(), "agentic-smoke");

const POLL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const HELLO_CONTENT = "hello from agentic-os";
const PROMPT =
  `Create a file named hello.txt containing exactly: ${HELLO_CONTENT}\n` +
  `Do nothing else. Do not run tests, do not commit.`;
const VERIFY_COMMAND =
  `node -e "process.exit(require('fs').existsSync('hello.txt') && ` +
  `require('fs').readFileSync('hello.txt','utf8').includes('${HELLO_CONTENT}') ? 0 : 1)"`;

const FAILURE_STATES = new Set(["failed", "timeout", "aborted", "orphaned", "verification_failed"]);

// Populated as soon as known, so fail()/dumpDiagnostics() can use whatever
// is available at the point of failure.
let scratchRoot;
let repoDir;
let runId;
let workerId;
let mcpClient;
let agenticServer;

function log(...args) {
  console.log(`[smoke ${new Date().toISOString()}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, cwd, opts = {}) {
  const { allowFail, ...spawnOpts } = opts;
  // shell:false by default: git.exe/taskkill.exe are real executables, and
  // shell:true on Windows does NOT quote array args containing spaces
  // (verified empirically -- it broke `git config user.name "Agentic OS
  // Smoke"` by leaving it unquoted for cmd.exe to re-split). Only npm
  // (an .cmd shim on Windows -- see opencode-client/binary.ts's docs-notes
  // for the same class of issue) needs shell:true, passed explicitly at
  // that call site.
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", ...spawnOpts });
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}\n` +
        `--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`
    );
  }
  return result;
}

function git(args, cwd) {
  return run("git", args, cwd);
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
  console.error("\n[smoke] ---- diagnostics ----");
  if (repoDir && runId) {
    const rd = runDirFor(repoDir, runId);

    if (workerId) {
      const metaPath = path.join(rd, "workers", workerId, "meta.json");
      console.error(`[smoke] worker meta (${metaPath}):`);
      console.error(await tailFile(metaPath));

      console.error("[smoke] last worker log events:");
      try {
        const res = await callTool("stream_worker_log", { workerId, sinceSeq: 0 });
        console.error(JSON.stringify(res.data, null, 2).slice(-4000));
      } catch (err) {
        console.error(`<could not fetch worker log: ${err.message}>`);
      }
    }

    const serveLog = path.join(rd, "opencode-serve.log");
    console.error(`[smoke] opencode-serve.log tail (${serveLog}):`);
    console.error(await tailFile(serveLog));
  }
  if (scratchRoot) {
    console.error(`[smoke] scratch dir PRESERVED for inspection: ${scratchRoot}`);
  }
  console.error("[smoke] ---- end diagnostics ----\n");
}

async function fail(message) {
  console.error(`\n[smoke] FAILURE: ${message}`);
  await dumpDiagnostics().catch((err) => console.error(`[smoke] diagnostics dump itself failed: ${err.message}`));
  process.exit(1);
}

async function main() {
  log("building packages/core (npm run build)...");
  run("npm", ["run", "build"], REPO_ROOT, { stdio: "inherit", shell: true });
  log("build ok");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  scratchRoot = path.join(SCRATCH_BASE_DIR, `smoke-${ts}`);
  repoDir = path.join(scratchRoot, "repo");
  await mkdir(repoDir, { recursive: true });

  log(`scratch repo: ${repoDir}`);
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "smoke@agentic-os.local"], repoDir);
  git(["config", "user.name", "Agentic OS Smoke"], repoDir);
  git(["config", "core.autocrlf", "false"], repoDir);
  await writeFile(path.join(repoDir, "README.md"), "# agentic-os smoke scratch repo\n", "utf8");
  git(["add", "README.md"], repoDir);
  git(["commit", "-m", "initial commit"], repoDir);

  // Not re-exported from dist/index.js -- see module doc above.
  const { createAgenticMcpServer } = await import("../packages/core/dist/mcp/server.js");
  agenticServer = await createAgenticMcpServer({ projectDir: repoDir, platformConfigDir: PLATFORM_CONFIG_DIR });

  runId = JSON.parse(await readFile(path.join(repoDir, ".agentic-os", "current-run.json"), "utf8")).runId;
  log(`runId: ${runId}`);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await agenticServer.server.connect(serverTransport);
  mcpClient = new Client({ name: "smoke-client", version: "0.0.0" });
  await mcpClient.connect(clientTransport);

  const model = process.env.SMOKE_MODEL;
  const spawnArgs = { taskId: "smoke-1", prompt: PROMPT };
  if (model) spawnArgs.model = model;
  log(`spawn_worker (model: ${model ?? "config/models.yaml routing.default"})...`);

  const spawned = await callTool("spawn_worker", spawnArgs);
  if (spawned.isError) {
    await fail(`spawn_worker returned isError: ${JSON.stringify(spawned.data)}`);
    return;
  }
  workerId = spawned.data.workerId;
  const branchName = spawned.data.branchName;
  log(`spawned workerId=${workerId} worktree=${spawned.data.worktreePath} session=${spawned.data.sessionId}`);

  // -- poll loop ------------------------------------------------------------
  const timeline = [];
  let lastState;
  let sinceSeq = 0;
  const deadline = Date.now() + MAX_WAIT_MS;

  for (;;) {
    const status = await callTool("worker_status", { workerId });
    if (status.isError) {
      await fail(`worker_status returned isError: ${JSON.stringify(status.data)}`);
      return;
    }
    const w = status.data.worker;
    log(`state=${w.state} costUsd=${w.costUsd ?? 0}`);
    if (w.state !== lastState) {
      timeline.push({ state: w.state, atIso: new Date().toISOString(), costUsd: w.costUsd });
      lastState = w.state;
    }

    // Drain all new log events this poll (stream_worker_log caps at 200/call).
    let truncated = true;
    while (truncated) {
      const streamed = await callTool("stream_worker_log", { workerId, sinceSeq });
      if (streamed.isError || !streamed.data) break;
      for (const evt of streamed.data.events ?? []) {
        log(`  [log seq=${evt.seq}] ${evt.type}${evt.summary ? `: ${evt.summary}` : ""}`);
      }
      sinceSeq = streamed.data.nextSinceSeq ?? sinceSeq;
      truncated = Boolean(streamed.data.truncated);
    }

    if (w.state === "completed") break;
    if (FAILURE_STATES.has(w.state)) {
      await fail(`worker reached failure state '${w.state}': ${JSON.stringify(w.lastError ?? {})}`);
      return;
    }
    if (Date.now() > deadline) {
      await callTool("abort_worker", { workerId, reason: "smoke test exceeded 10 minute wait" }).catch(() => {});
      await fail(`timed out after ${MAX_WAIT_MS}ms waiting for worker to complete (last state '${w.state}')`);
      return;
    }
    await sleep(POLL_MS);
  }

  // -- verify -----------------------------------------------------------------
  log("worker completed; running verify_worker...");
  const verified = await callTool("verify_worker", { workerId, command: VERIFY_COMMAND });
  if (verified.isError || !verified.data?.passed) {
    await fail(`verify_worker failed: ${JSON.stringify(verified.data)}`);
    return;
  }
  timeline.push({ state: "verified", atIso: new Date().toISOString() });
  log("verify passed");

  // -- finalize (merge) --------------------------------------------------------
  // On Windows, the just-completed opencode session can briefly hold a file
  // handle open on its own worktree, making the post-merge `git worktree
  // remove` fail with EPERM/"Permission denied" even though the actual git
  // merge itself already landed on the target branch (worker/index.ts's
  // finalizeWorker runs mergeBranch() to completion *before* removeWorktree()
  // -- only the cleanup step can fail this way). Confirmed empirically
  // against a real run here: hammering finalize_worker again just races a
  // second `git worktree remove` against the OS's own delayed handle
  // release, producing a *different* transient git error each time as the
  // worktree's on-disk/admin state shifts underneath it. So: retry the real
  // tool once (it may complete cleanly), but if it still isn't reporting
  // merged:true, fall back to the same ground truth step 7's own assertions
  // below use anyway -- checking the actual repo -- rather than continuing
  // to hammer a moving target. This is the architecture's own core
  // principle applied to the tool's report itself: never trust self-report,
  // verify independently.
  log("finalize_worker (merge)...");
  let finalized = await callTool("finalize_worker", { workerId, action: "merge" });
  if (finalized.isError || !finalized.data?.merged) {
    log(`finalize_worker merge attempt 1 not done yet: ${JSON.stringify(finalized.data)}; retrying once after a delay...`);
    await sleep(3000);
    finalized = await callTool("finalize_worker", { workerId, action: "merge" });
  }

  let mergeSha;
  if (!finalized.isError && finalized.data?.merged) {
    mergeSha = finalized.data.mergeSha;
    log(`merged via finalize_worker, sha=${mergeSha}`);
  } else {
    log(
      `finalize_worker still not reporting merged:true (${JSON.stringify(finalized.data)}); ` +
        `checking git state on '${branchName}' directly before failing...`
    );
    const mergedBranches = git(["branch", "--merged", "main"], repoDir).stdout;
    if (branchName && mergedBranches.includes(branchName)) {
      mergeSha = git(["rev-parse", "main"], repoDir).stdout.trim();
      log(`git confirms '${branchName}' is merged into main despite finalize_worker's cleanup-step error; sha=${mergeSha}`);
    } else {
      await fail(`finalize_worker merge failed, and git does not show '${branchName}' merged into main either: ${JSON.stringify(finalized.data)}`);
      return;
    }
  }
  timeline.push({ state: "merged", atIso: new Date().toISOString() });

  // -- assertions on the scratch repo ------------------------------------------
  const fullShas = git(["log", "main", "--format=%H"], repoDir).stdout.split(/\r?\n/).filter(Boolean);
  if (!fullShas.includes(mergeSha)) {
    await fail(`git log main does not contain merge sha ${mergeSha}. Shas seen: ${fullShas.join(", ")}`);
    return;
  }
  const helloPath = path.join(repoDir, "hello.txt");
  if (!(await pathExists(helloPath))) {
    await fail(`hello.txt not found on main at ${helloPath}`);
    return;
  }
  const helloContent = await readFile(helloPath, "utf8");
  if (!helloContent.includes(HELLO_CONTENT)) {
    await fail(`hello.txt content unexpected: ${JSON.stringify(helloContent)}`);
    return;
  }
  log("assertions passed: merge commit present on main, hello.txt correct");

  // -- final report -------------------------------------------------------------
  const finalStatus = await callTool("worker_status", {}).catch(() => undefined);
  console.log("\n[smoke] ==== FINAL REPORT ====");
  console.log("state timeline:");
  for (const t of timeline) {
    console.log(`  ${t.atIso}  ${t.state}${t.costUsd !== undefined ? `  costUsd=${t.costUsd}` : ""}`);
  }
  console.log(`merged sha: ${mergeSha}`);
  console.log(`model used: ${model ?? "config/models.yaml routing.default"}`);
  if (finalStatus?.data?.budget) {
    console.log(`budget: ${JSON.stringify(finalStatus.data.budget)}`);
  }
  console.log("[smoke] ==== SMOKE PASSED ====\n");

  // -- cleanup (success only) ------------------------------------------------------
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

  await sleep(500); // let the OS release file handles before rm

  const worktreesDir = `${repoDir}-agentic-worktrees`;
  await rm(worktreesDir, { recursive: true, force: true }).catch(() => {});
  await rm(scratchRoot, { recursive: true, force: true }).catch((err) =>
    log(`could not fully remove scratch dir (non-fatal): ${err.message}`)
  );

  log("cleanup done");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`[smoke] unexpected error: ${err.stack ?? err.message}`);
  await dumpDiagnostics().catch(() => {});
  process.exit(1);
});
