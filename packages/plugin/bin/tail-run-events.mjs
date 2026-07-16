#!/usr/bin/env node
/**
 * Tails the current run's event log so the user sees cohort activity
 * live in Claude Code's monitor pane, without polling MCP tools for it.
 *
 * Resolves <cwd>/.cohort/current-run.json -> runs/<runId>/events.jsonl
 * (the same run-level log `mcp/server.ts`'s runTool() appends one line to
 * per tool call — see docs/ARCHITECTURE.md "State & persistence"). Re-reads
 * current-run.json on every poll so it follows the run forward if a new one
 * starts. Never dumps a file's pre-existing history on first attach: it
 * only prints lines appended *after* this process started watching that
 * file, like `tail -f`, not `cat`.
 *
 * fs.watch is used for fast reaction where the platform supports it, but a
 * 2s poll is always running underneath as the source of truth -- fs.watch
 * is unreliable before the file exists and on some filesystems/CI runners,
 * so it's an optimization here, never the only mechanism.
 *
 * Never exits on its own (a plugin monitor is expected to run for the
 * lifetime of the session); only a signal from Claude Code stops it.
 */

import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";

const POLL_MS = 2000;
const PROJECT_DIR = process.cwd();
const CURRENT_RUN_PATH = path.join(PROJECT_DIR, ".cohort", "current-run.json");

let currentRunId; // runId this process is currently tailing, or undefined
let targetPath; // runs/<runId>/events.jsonl for currentRunId
let knownSize = 0; // bytes of targetPath already printed
let pending = ""; // buffered partial (not-yet-newline-terminated) tail
let dirWatcher; // fs.watch handle on the run dir, re-armed per run
let checking = false; // reentrancy guard: poll + watch callback can overlap

function print(line) {
  process.stdout.write(`[cohort] ${line}\n`);
}

async function readRunId() {
  try {
    const raw = await readFile(CURRENT_RUN_PATH, "utf8");
    return JSON.parse(raw).runId;
  } catch {
    return undefined; // not present yet (or unreadable) -- wait quietly
  }
}

function armWatcher(runDir) {
  dirWatcher?.close();
  dirWatcher = undefined;
  try {
    dirWatcher = watch(runDir, { persistent: false }, (_event, filename) => {
      if (filename === "events.jsonl" || filename === null) {
        void check();
      }
    });
  } catch {
    // Directory may not exist yet, or the platform lacks watch support here
    // -- the 2s poll loop covers this either way.
  }
}

async function switchTarget(runId) {
  currentRunId = runId;
  const runDir = path.join(PROJECT_DIR, ".cohort", "runs", runId);
  targetPath = path.join(runDir, "events.jsonl");
  pending = "";
  // Attach at current end-of-file: this is a live tail, not a replay of a
  // run already in progress when this process started.
  try {
    knownSize = (await stat(targetPath)).size;
  } catch {
    knownSize = 0;
  }
  armWatcher(runDir);
}

async function check() {
  if (checking) return;
  checking = true;
  try {
    const runId = await readRunId();
    if (!runId) return; // no run yet -- stay quiet, keep polling
    if (runId !== currentRunId) {
      await switchTarget(runId);
    }

    let size;
    try {
      size = (await stat(targetPath)).size;
    } catch {
      return; // events.jsonl not created yet for this run -- wait quietly
    }
    if (size <= knownSize) return;

    const raw = await readFile(targetPath, "utf8");
    const appended = pending + raw.slice(knownSize);
    knownSize = size;

    const lines = appended.split("\n");
    pending = lines.pop() ?? ""; // last element is "" for a fully newline-terminated read, else a partial line
    for (const line of lines) {
      if (line.length > 0) print(line);
    }
  } catch (err) {
    print(`<tail error, will retry: ${err.message}>`);
  } finally {
    checking = false;
  }
}

setInterval(() => void check(), POLL_MS);
void check();
