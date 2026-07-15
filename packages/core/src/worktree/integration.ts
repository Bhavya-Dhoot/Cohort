import { mergeBranch, type RunGitFn } from "./merge.js";
import { runGit } from "./git.js";

/**
 * Derives the per-run integration branch name: `agentic/integration/<runId>`.
 * `runId` is sanitized to a valid git ref segment — any run of characters
 * that aren't `[A-Za-z0-9._-]` collapses to a single `-`, and leading/
 * trailing `-`/`.` are trimmed (git rejects refs starting with `.` or
 * ending in `.lock`, and a trailing `-` is just noise). This keeps the
 * result deterministic for a given `runId` without depending on git itself
 * to validate it.
 */
export function integrationBranchName(runId: string): string {
  const sanitized = runId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `agentic/integration/${sanitized}`;
}

export interface EnsureIntegrationBranchOptions {
  repoDir: string;
  runId: string;
  baseRef: string;
}

export interface EnsureIntegrationBranchResult {
  branchName: string;
  created: boolean;
}

/**
 * Ensures the per-run integration branch exists, branched from `baseRef`.
 *
 * Uses `git branch <name> <baseRef>` rather than `git switch -c`/`checkout
 * -b`, which creates the branch without touching the repo's current
 * checkout (HEAD, index, and working tree are left exactly as they were) —
 * required since `repoDir` may be the shared repo other callers are actively
 * using, not a disposable worktree.
 *
 * Idempotent: if the branch already exists (checked via `git rev-parse
 * --verify --quiet refs/heads/<name>`), it's reused as-is (NOT reset to
 * `baseRef`) and `created` is `false`.
 */
export async function ensureIntegrationBranch(
  opts: EnsureIntegrationBranchOptions,
  deps: { runGit?: RunGitFn } = {}
): Promise<EnsureIntegrationBranchResult> {
  const { repoDir, runId, baseRef } = opts;
  const git = deps.runGit ?? runGit;
  const branchName = integrationBranchName(runId);

  const exists = await git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
    repoDir
  )
    .then(() => true)
    .catch(() => false);

  if (exists) {
    return { branchName, created: false };
  }

  await git(["branch", "--", branchName, baseRef], repoDir);
  return { branchName, created: true };
}

export interface MergeInDagOrderOptions {
  repoDir: string;
  integrationBranch: string;
  /**
   * Merges to apply, IN THE ORDER THEY SHOULD BE APPLIED. Computing that
   * (DAG-topological) order is the job of the tasks/dag module, not this
   * one — this function just merges the list it's handed, in the order
   * it's handed.
   */
  merges: { taskId: string; sourceBranch: string }[];
}

export interface MergeOutcome {
  taskId: string;
  sourceBranch: string;
  outcome: "merged" | "conflict" | "skipped";
  mergeSha?: string;
  conflictFiles?: string[];
}

export interface MergeInDagOrderResult {
  results: MergeOutcome[];
  allMerged: boolean;
}

/**
 * Merges `merges` into `integrationBranch`, one at a time, in the order
 * given (see `MergeInDagOrderOptions.merges`).
 *
 * Stop-on-conflict: integration is inherently sequential (each merge lands
 * on top of the previous ones), so once one merge conflicts there is no
 * sound way to keep applying the rest — a later branch may have been
 * written assuming an earlier one's changes were already present. On the
 * first conflict, that merge is recorded as `"conflict"` and every
 * remaining entry is recorded as `"skipped"` without attempting them. This
 * is a deliberate stop, not a bug: it hands the decision (reorder, drop the
 * conflicting task, request a manual resolution) back to the orchestrator
 * rather than guessing.
 *
 * Reuses `mergeBranch` for the actual merge/abort mechanics; the caller's
 * contract (clean working tree in `repoDir`) is inherited unchanged.
 */
export async function mergeInDagOrder(
  opts: MergeInDagOrderOptions,
  deps: { runGit?: RunGitFn } = {}
): Promise<MergeInDagOrderResult> {
  const { repoDir, integrationBranch, merges } = opts;
  const results: MergeOutcome[] = [];
  let stopped = false;

  for (const { taskId, sourceBranch } of merges) {
    if (stopped) {
      results.push({ taskId, sourceBranch, outcome: "skipped" });
      continue;
    }

    const mergeResult = await mergeBranch(
      { repoDir, sourceBranch, targetBranch: integrationBranch },
      deps
    );

    if (mergeResult.merged) {
      results.push({ taskId, sourceBranch, outcome: "merged", mergeSha: mergeResult.mergeSha });
    } else {
      results.push({
        taskId,
        sourceBranch,
        outcome: "conflict",
        conflictFiles: mergeResult.conflictFiles
      });
      stopped = true;
    }
  }

  return { results, allMerged: !stopped };
}
