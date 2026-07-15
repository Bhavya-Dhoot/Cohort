import type { OpencodeClient, SessionUsage } from "../opencode-client/types.js";

/**
 * A worker's lifecycle state, persisted verbatim in `meta.json`. Mirrors
 * docs/ARCHITECTURE.md's "Worker lifecycle" diagram, with one deliberate
 * scope cut: there is no `retrying` state / `retry()` method here — only
 * `finalize(..., "discard")` moves a terminal-ish failure state forward.
 * Re-running the identical prompt on the same worktree is a replan decision
 * for a higher layer, not something this module does automatically.
 */
export type WorkerState =
  | "created"
  | "worktree_provisioning"
  | "worktree_ready"
  | "session_starting"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "aborted"
  | "orphaned"
  | "verifying"
  | "verified"
  | "verification_failed"
  | "merged"
  | "discarded";

export type FailureClassification = "infra" | "logic";

export interface WorkerMeta {
  workerId: string;
  runId: string;
  taskId: string;
  state: WorkerState;
  prompt: string;
  model?: string;
  agentId?: string;
  baseUrl?: string;
  sessionId?: string;
  worktreePath?: string;
  branchName?: string;
  baseRef?: string;
  createdAt: number;
  updatedAt: number;
  attempts: { infra: number };
  lastError?: { message: string; classification: FailureClassification };
  timeoutAt?: number;
  verify?: { passed: boolean; exitCode: number | null; timedOut: boolean; at: number };
  merge?: { merged: boolean; mergeSha?: string; conflictFiles?: string[]; at: number };
  usage?: SessionUsage;
}

export interface SpawnOptions {
  taskId: string;
  prompt: string;
  model?: string;
  agentId?: string;
  workerId?: string;
}

export interface WorkerSupervisorDefaults {
  /** Wall-clock cap on a worker's prompt turn. Default 30 minutes. */
  timeoutMs?: number;
  /** Max infra-classified retries per spawn-pipeline step. Default 3. */
  infraRetryMax?: number;
  /** Backoff delays (ms) between infra retries; the last value repeats past its length. Default [2000, 8000, 30000]. */
  infraBackoffMs?: number[];
  /** Branch/ref new worktrees are created from. Default: repoDir's current branch. */
  baseRef?: string;
}

export interface WorkerSupervisorDeps {
  client: OpencodeClient;
  /** Directory holding `workers/<workerId>/{meta.json,events.jsonl}` (typically `<project>/.agentic-os`). */
  stateDir: string;
  /** The target project's git repo. */
  repoDir: string;
  /** Base directory worktrees are provisioned under (outside `repoDir`). */
  worktreeBaseDir: string;
  runId: string;
  defaults?: WorkerSupervisorDefaults;
}

export interface CollectResult {
  meta: WorkerMeta;
  /** Union of committed (`baseRef..HEAD`) and uncommitted (`git status --porcelain`) changed paths. */
  filesChanged: string[];
  /** `git diff --stat baseRef..HEAD` output for committed work only. */
  diffstat: string;
}

export interface WorkerSupervisor {
  spawn(opts: SpawnOptions): Promise<WorkerMeta>;
  status(workerId: string): Promise<WorkerMeta>;
  list(): Promise<WorkerMeta[]>;
  abort(workerId: string, reason: string): Promise<WorkerMeta>;
  collect(workerId: string): Promise<CollectResult>;
  verify(workerId: string, command: string, timeoutMs?: number): Promise<WorkerMeta>;
  finalize(workerId: string, action: "merge" | "discard", targetBranch?: string): Promise<WorkerMeta>;
  reconcile(): Promise<WorkerMeta[]>;
}
