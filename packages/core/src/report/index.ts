import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { readJsonIfExists } from "../lib/fs.js";
import { openEventLog } from "../events/index.js";
import type { WorkerMeta, WorkerState } from "../worker/types.js";
import type { TaskCard, TaskCardStatus } from "../tasks/schema.js";
import type { Plan, ReplanRecord } from "../plan/schema.js";
import type { BudgetSnapshot } from "../budget/index.js";
import type { ReviewVerdict, ReviewVerdictOutcome } from "../review/schema.js";

/**
 * `generateRunReport(runDir)` renders a run's on-disk artifacts
 * (`plan.json`, `task-board.json`, `workers/<id>/meta.json`, `cost.json`,
 * `reviews/<taskId>/*.json`, `replans/*.json`, `events.jsonl`) into a single
 * markdown report with hand-rolled mermaid diagrams. Pure and deterministic:
 * no LLM calls, no network, and every artifact read is optional -- a
 * missing or malformed file degrades the relevant section to "_no data_"
 * rather than throwing, so a partial/in-flight run still renders.
 *
 * `RunReportSummary`'s shape is a cross-module contract: an MCP `run_report`
 * tool (wired by a different task) calls `generateRunReport` directly, so
 * this interface must not change without updating that caller too.
 */

export interface RunReportSummary {
  runId: string;
  objective?: string;
  tasks: { total: number; done: number; failed: number; pending: number };
  workers: { total: number; merged: number; failed: number; byState: Record<string, number> };
  cost: { committedUsd: number; tier: string };
  reviews: { total: number; blocking: number };
  durationMs?: number;
}

/** Worker states that count as a failure for `workers.failed` and trigger the failure report. */
const FAILURE_STATES: ReadonlySet<WorkerState> = new Set([
  "failed",
  "timeout",
  "aborted",
  "orphaned",
  "verification_failed"
]);

/* ------------------------------------------------------------------ */
/* Safe disk reads -- never throw, so a malformed/missing artifact only */
/* drops its own section rather than failing the whole report.          */
/* ------------------------------------------------------------------ */

/**
 * Like `readJsonIfExists`, but also swallows parse errors and shape
 * mismatches (any thrown error), returning `undefined` instead. Malformed
 * JSON on disk (a partially-written artifact, a hand-edited file) must
 * degrade a section, not crash the whole report.
 */
async function safeReadJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonIfExists<T>(filePath);
  } catch {
    return undefined;
  }
}

async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

async function readJsonFilesInDir<T>(dirPath: string): Promise<T[]> {
  const entries = await listDir(dirPath);
  const out: T[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".json")) continue;
    const data = await safeReadJson<T>(join(dirPath, entry));
    if (data !== undefined) out.push(data);
  }
  return out;
}

/** Scans each `runDir/workers/<id>/meta.json`, sorted by workerId for deterministic output. */
async function readWorkers(runDir: string): Promise<WorkerMeta[]> {
  const workersDir = join(runDir, "workers");
  const ids = await listDir(workersDir);
  const metas: WorkerMeta[] = [];
  for (const id of ids) {
    const meta = await safeReadJson<WorkerMeta>(join(workersDir, id, "meta.json"));
    if (meta && typeof meta.workerId === "string" && typeof meta.state === "string") {
      metas.push(meta);
    }
  }
  return metas.sort((a, b) => a.workerId.localeCompare(b.workerId));
}

/** Scans each `runDir/reviews/<taskId>/` directory's verdict files, keyed by taskId, sorted. */
async function readReviews(runDir: string): Promise<Map<string, ReviewVerdict[]>> {
  const reviewsDir = join(runDir, "reviews");
  const taskIds = await listDir(reviewsDir);
  const map = new Map<string, ReviewVerdict[]>();
  for (const taskId of [...taskIds].sort()) {
    const verdicts = await readJsonFilesInDir<ReviewVerdict>(join(reviewsDir, taskId));
    const valid = verdicts.filter(
      (v) =>
        v &&
        typeof v.reviewerId === "string" &&
        typeof v.verdict === "string" &&
        typeof v.at === "number"
    );
    if (valid.length > 0) map.set(taskId, valid);
  }
  return map;
}

async function safeReadEventCount(runDir: string): Promise<number> {
  try {
    const events = await openEventLog(join(runDir, "events.jsonl")).read();
    return events.length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function fmtUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}

/** All timestamps render UTC -- `Date#toISOString` is always UTC by definition. */
function fmtUtc(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "_invalid-date_" : d.toISOString();
}

function fmtDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/** Escapes a string for use inside a quoted mermaid node/task label. */
function escapeMermaidLabel(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ");
}

/** Mermaid node/task ids must be simple tokens; sanitize anything else out. */
function sanitizeMermaidId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "id";
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/* ------------------------------------------------------------------ */
/* Review helpers                                                       */
/* ------------------------------------------------------------------ */

/** Each reviewer's most recent verdict (by `at`), matching `review/index.ts`'s `summarizeTask` semantics. */
function latestVerdictByReviewer(verdicts: ReviewVerdict[]): Map<string, ReviewVerdict> {
  const sorted = [...verdicts].sort((a, b) => a.at - b.at);
  const latest = new Map<string, ReviewVerdict>();
  for (const v of sorted) latest.set(v.reviewerId, v);
  return latest;
}

function isBlockingVerdict(outcome: ReviewVerdictOutcome): boolean {
  return outcome === "block" || outcome === "revise";
}

/* ------------------------------------------------------------------ */
/* Section 1: header + summary table                                    */
/* ------------------------------------------------------------------ */

function renderHeader(summary: RunReportSummary, eventCount: number): string {
  const t = summary.tasks;
  const w = summary.workers;
  const r = summary.reviews;
  const duration = summary.durationMs === undefined ? "_n/a_" : fmtDuration(summary.durationMs);
  return [
    `# Run Report: ${summary.runId}`,
    "",
    `**Objective:** ${summary.objective ? escapeTableCell(summary.objective) : "_none recorded_"}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Tasks (total/done/failed/pending) | ${t.total} / ${t.done} / ${t.failed} / ${t.pending} |`,
    `| Workers (total/merged/failed) | ${w.total} / ${w.merged} / ${w.failed} |`,
    `| Cost (committed / tier) | ${fmtUsd(summary.cost.committedUsd)} / ${summary.cost.tier} |`,
    `| Reviews (total/blocking) | ${r.total} / ${r.blocking} |`,
    `| Duration | ${duration} |`,
    `| Events logged | ${eventCount} |`
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Section 2: execution timeline (mermaid gantt)                        */
/* ------------------------------------------------------------------ */

function renderTimeline(workers: WorkerMeta[]): string {
  const lines = ["## Execution Timeline", ""];
  if (workers.length === 0) {
    lines.push("_no data_");
    return lines.join("\n");
  }
  lines.push(
    "```mermaid",
    "gantt",
    "    title Execution Timeline",
    "    dateFormat x",
    "    axisFormat %H:%M:%S",
    "    section Workers"
  );
  for (const w of workers) {
    const start = w.createdAt;
    // Guard against zero/negative-duration spans (e.g. a worker that never
    // progressed past `created`) so mermaid always sees a positive span.
    const end = w.updatedAt > start ? w.updatedAt : start + 1000;
    const id = sanitizeMermaidId(w.workerId);
    const label = escapeMermaidLabel(`${w.taskId} (${w.state})`).replace(/:/g, "-");
    lines.push(`    ${label} : ${id}, ${start}, ${end}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Section 3: task DAG (mermaid graph TD)                               */
/* ------------------------------------------------------------------ */

function statusBucket(status: TaskCardStatus): "done" | "failed" | "running" | "pending" {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "pending"; // pending, assigned, blocked
}

function statusEmoji(status: TaskCardStatus): string {
  switch (status) {
    case "done":
      return "✅"; // check mark
    case "failed":
      return "❌"; // cross mark
    case "running":
      return "🔄"; // arrows
    case "blocked":
      return "⛔"; // no entry
    case "assigned":
      return "🟡"; // yellow circle
    default:
      return "⚪"; // white circle
  }
}

function renderTaskDag(tasks: TaskCard[]): string {
  const lines = ["## Task DAG", ""];
  if (tasks.length === 0) {
    lines.push("_no data_");
    return lines.join("\n");
  }
  lines.push("```mermaid", "graph TD");
  for (const t of tasks) {
    const id = sanitizeMermaidId(t.id);
    const label = escapeMermaidLabel(`${statusEmoji(t.status)} ${t.id}: ${t.title} (${t.status})`);
    lines.push(`    ${id}["${label}"]`);
  }
  for (const t of tasks) {
    const id = sanitizeMermaidId(t.id);
    for (const dep of t.dependsOn ?? []) {
      lines.push(`    ${sanitizeMermaidId(dep)} --> ${id}`);
    }
  }
  lines.push(
    "    classDef done fill:#c8e6c9,stroke:#2e7d32,color:#1b5e20",
    "    classDef failed fill:#ffcdd2,stroke:#c62828,color:#7f0000",
    "    classDef running fill:#bbdefb,stroke:#1565c0,color:#0d47a1",
    "    classDef pending fill:#eeeeee,stroke:#616161,color:#212121"
  );
  for (const t of tasks) {
    lines.push(`    class ${sanitizeMermaidId(t.id)} ${statusBucket(t.status)}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Section 4: model & cost usage                                        */
/* ------------------------------------------------------------------ */

function renderCostUsage(workers: WorkerMeta[], cost: BudgetSnapshot | undefined): string {
  const lines = ["## Model & Cost Usage", ""];
  if (workers.length === 0) {
    lines.push("_no data_");
    return lines.join("\n");
  }
  lines.push("| Worker | Task | Model | State | Cost (USD) |", "|---|---|---|---|---|");
  const perModel = new Map<string, { count: number; total: number }>();
  for (const w of workers) {
    const workerCost = w.usage?.costUsd ?? cost?.perWorker?.[w.workerId]?.committedUsd ?? 0;
    const model = w.model ?? "_unknown_";
    lines.push(
      `| ${escapeTableCell(w.workerId)} | ${escapeTableCell(w.taskId)} | ${escapeTableCell(model)} | ${w.state} | ${fmtUsd(workerCost)} |`
    );
    const bucket = perModel.get(model) ?? { count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += workerCost;
    perModel.set(model, bucket);
  }
  lines.push("", "**Per-model rollup**", "", "| Model | Workers | Total Cost (USD) |", "|---|---|---|");
  for (const model of [...perModel.keys()].sort()) {
    const bucket = perModel.get(model)!;
    lines.push(`| ${escapeTableCell(model)} | ${bucket.count} | ${fmtUsd(bucket.total)} |`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Section 5: reviews                                                   */
/* ------------------------------------------------------------------ */

function renderReviews(reviewsByTask: Map<string, ReviewVerdict[]>): string {
  const lines = ["## Reviews", ""];
  if (reviewsByTask.size === 0) {
    lines.push("_no data_");
    return lines.join("\n");
  }
  for (const taskId of [...reviewsByTask.keys()].sort()) {
    const verdicts = reviewsByTask.get(taskId)!;
    const latest = latestVerdictByReviewer(verdicts);
    const blocking = [...latest.values()].some((v) => isBlockingVerdict(v.verdict));
    lines.push(`### Task ${taskId}${blocking ? " -- BLOCKING" : ""}`, "");
    lines.push("| Reviewer | Verdict |", "|---|---|");
    for (const reviewerId of [...latest.keys()].sort()) {
      const v = latest.get(reviewerId)!;
      lines.push(`| ${escapeTableCell(reviewerId)} | ${v.verdict} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/* ------------------------------------------------------------------ */
/* Section 6: failure report                                            */
/* ------------------------------------------------------------------ */

function renderFailureReport(workers: WorkerMeta[], replans: ReplanRecord[]): string {
  const lines = ["## Failure Report", ""];
  const failing = workers.filter((w) => FAILURE_STATES.has(w.state) || w.lastError !== undefined);
  if (failing.length === 0) {
    lines.push("_no data_");
    return lines.join("\n");
  }
  for (const w of failing) {
    lines.push(`### Worker ${w.workerId} (task ${w.taskId})`, "");
    lines.push(`- **State:** ${w.state}`);
    if (w.lastError) {
      lines.push(`- **Classification:** ${w.lastError.classification}`);
      lines.push(`- **Error:** ${escapeTableCell(w.lastError.message)}`);
    } else {
      lines.push("- **Classification:** _none recorded_");
      lines.push("- **Error:** _none recorded_");
    }
    if (w.verify) {
      lines.push(
        `- **Verify:** exitCode=${w.verify.exitCode ?? "null"}, timedOut=${w.verify.timedOut} (at ${fmtUtc(w.verify.at)})`
      );
    }
    const addressedBy = replans.filter((r) => r.affectedTaskIds.includes(w.taskId));
    lines.push(
      addressedBy.length > 0
        ? `- **Replan:** addressed by ${addressedBy.map((r) => `#${r.iteration}`).join(", ")}`
        : "- **Replan:** not addressed"
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/* ------------------------------------------------------------------ */
/* Summary + entry point                                                */
/* ------------------------------------------------------------------ */

function buildSummary(
  runId: string,
  plan: Plan | undefined,
  tasks: TaskCard[],
  workers: WorkerMeta[],
  cost: BudgetSnapshot | undefined,
  reviewsByTask: Map<string, ReviewVerdict[]>
): RunReportSummary {
  // TaskCardStatus has 6 states but RunReportSummary's contract only has
  // three buckets; assigned/running/blocked all count as "pending" (not yet
  // finished) alongside plain pending.
  const taskCounts = { total: tasks.length, done: 0, failed: 0, pending: 0 };
  for (const t of tasks) {
    if (t.status === "done") taskCounts.done += 1;
    else if (t.status === "failed") taskCounts.failed += 1;
    else taskCounts.pending += 1;
  }

  const byState: Record<string, number> = {};
  let merged = 0;
  let failedWorkers = 0;
  for (const w of workers) {
    byState[w.state] = (byState[w.state] ?? 0) + 1;
    if (w.state === "merged") merged += 1;
    if (FAILURE_STATES.has(w.state)) failedWorkers += 1;
  }

  let durationMs: number | undefined;
  if (workers.length > 0) {
    const minCreated = Math.min(...workers.map((w) => w.createdAt));
    const maxUpdated = Math.max(...workers.map((w) => w.updatedAt));
    durationMs = Math.max(0, maxUpdated - minCreated);
  }

  let totalReviews = 0;
  let blockingTasks = 0;
  for (const verdicts of reviewsByTask.values()) {
    totalReviews += verdicts.length;
    const latest = latestVerdictByReviewer(verdicts);
    if ([...latest.values()].some((v) => isBlockingVerdict(v.verdict))) blockingTasks += 1;
  }

  return {
    runId,
    objective: typeof plan?.objective === "string" ? plan.objective : undefined,
    tasks: taskCounts,
    workers: { total: workers.length, merged, failed: failedWorkers, byState },
    cost: { committedUsd: cost?.committedUsd ?? 0, tier: cost?.tier ?? "ok" },
    reviews: { total: totalReviews, blocking: blockingTasks },
    durationMs
  };
}

/**
 * Renders `runDir`'s on-disk artifacts into a markdown report plus the
 * structured `RunReportSummary` an MCP `run_report` tool returns alongside
 * it. Every artifact is optional and every read is fault-tolerant: a
 * missing directory, a missing file, or malformed JSON degrades only the
 * section/field that depended on it -- this function itself never throws
 * on account of run-directory contents.
 */
export async function generateRunReport(
  runDir: string
): Promise<{ markdown: string; summary: RunReportSummary }> {
  const runId = basename(runDir) || "unknown";

  const [plan, board, cost, workers, replansRaw, reviewsByTask, eventCount] = await Promise.all([
    safeReadJson<Plan>(join(runDir, "plan.json")),
    safeReadJson<{ tasks: TaskCard[] }>(join(runDir, "task-board.json")),
    safeReadJson<BudgetSnapshot>(join(runDir, "cost.json")),
    readWorkers(runDir),
    readJsonFilesInDir<ReplanRecord>(join(runDir, "replans")),
    readReviews(runDir),
    safeReadEventCount(runDir)
  ]);

  const tasks = (board?.tasks ?? [])
    .filter(
      (t): t is TaskCard =>
        !!t && typeof t.id === "string" && typeof t.status === "string" && Array.isArray(t.dependsOn)
    )
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const replans = replansRaw
    .filter((r): r is ReplanRecord => !!r && Array.isArray(r.affectedTaskIds))
    .slice()
    .sort((a, b) => a.iteration - b.iteration);

  const summary = buildSummary(runId, plan, tasks, workers, cost, reviewsByTask);

  const markdown = [
    renderHeader(summary, eventCount),
    renderTimeline(workers),
    renderTaskDag(tasks),
    renderCostUsage(workers, cost),
    renderReviews(reviewsByTask),
    renderFailureReport(workers, replans)
  ].join("\n\n");

  return { markdown, summary };
}
