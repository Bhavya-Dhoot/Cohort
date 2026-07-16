import { rm, stat } from "node:fs/promises";
import { GitCommandError, runGit } from "./git.js";
import type { RemoveWorktreeOptions } from "./types.js";

/** Injectable seam for `runGit`, so tests can force a specific git call to fail deterministically (mirrors merge.ts's `RunGitFn`). */
export type RunGitFn = typeof runGit;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(git: RunGitFn, repoDir: string, branchName: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], repoDir);
    return true;
  } catch (err) {
    if (err instanceof GitCommandError) return false;
    throw err;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Max attempts for the `git worktree remove` step when failures look transient. */
const REMOVE_MAX_ATTEMPTS = 4;

/** Backoff (ms) between retries of `git worktree remove`; the last value repeats for any attempt beyond the array's length. */
const REMOVE_RETRY_BACKOFF_MS = [200, 500, 1000];

/**
 * Matches the known-transient class of Windows worktree-removal failure: a
 * file handle from the just-exited worker process (or an AV scan) briefly
 * holding a lock on the directory right after the process ends. Anything
 * else (e.g. "not a valid ref") is a real error and must fail fast rather
 * than waste time retrying — except "is not a working tree", which gets its
 * own non-retrying recovery path via `NOT_A_WORKING_TREE_ERROR` below.
 */
const TRANSIENT_REMOVE_ERROR =
  /permission denied|resource busy|ebusy|being used by another process|failed to delete|unable to remove/i;

/**
 * Matches the "already de-registered" class of failure: the directory at
 * `worktreePath` still exists on disk, but git no longer has it registered
 * as a worktree (e.g. `.git/worktrees/<name>` was already pruned, or the
 * registration was lost in some other way — see guard.ts for how this state
 * arises). `git worktree remove` reports this as
 * `fatal: '<path>' is not a working tree`. This is NOT transient — retrying
 * the same command will never succeed — but it's also not a real failure:
 * there is nothing left for git to do, so we recover by best-effort pruning
 * and directly removing the leftover directory ourselves.
 */
const NOT_A_WORKING_TREE_ERROR = /not a working tree/i;

/**
 * Best-effort recovery for a worktree directory that still exists on disk
 * but is no longer registered with git (see `NOT_A_WORKING_TREE_ERROR`).
 * Both steps swallow their own errors: `worktree prune` may find nothing to
 * prune, and `worktreePath` may already be gone or briefly locked — neither
 * should block the caller from proceeding to the branch-delete/final-prune
 * steps that follow.
 */
async function recoverDeregisteredWorktree(git: RunGitFn, repoDir: string, worktreePath: string): Promise<void> {
  try {
    await git(["worktree", "prune"], repoDir);
  } catch {
    // Best-effort; nothing more to do here.
  }
  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch {
    // Best-effort; the directory may already be gone or briefly locked.
  }
}

/**
 * Removes a worktree and (optionally) force-deletes its branch, then prunes
 * stale worktree admin metadata. Idempotent: if `worktreePath` no longer
 * exists on disk, or `deleteBranch` no longer exists (e.g. a previous call
 * already removed them), those steps are skipped rather than erroring.
 *
 * The `git worktree remove` step alone retries (up to `REMOVE_MAX_ATTEMPTS`
 * attempts, with `REMOVE_RETRY_BACKOFF_MS` backoff between them) when the
 * failure matches `TRANSIENT_REMOVE_ERROR` — a known Windows race where a
 * lingering file handle or AV scan briefly locks the just-vacated directory.
 * A non-transient `GitCommandError` is rethrown immediately, no retry — with
 * one exception: a failure matching `NOT_A_WORKING_TREE_ERROR` means the
 * directory exists but git already lost track of it as a worktree (see
 * guard.ts). That's not transient either, but it's also not a real error —
 * it's handled once (no retry) via `recoverDeregisteredWorktree` and
 * treated as success. If retries are exhausted but `worktreePath` is gone
 * anyway (the removal may have partially succeeded, or another process
 * cleared it), that's treated as success per this function's existing
 * idempotency contract; otherwise the last error is rethrown with the path
 * and attempt count added.
 */
export async function removeWorktree(
  opts: RemoveWorktreeOptions,
  deps: { runGit?: RunGitFn; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const { repoDir, worktreePath, force, deleteBranch } = opts;
  const git = deps.runGit ?? runGit;
  const sleep = deps.sleep ?? defaultSleep;

  if (await pathExists(worktreePath)) {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);

    for (let attempt = 1; attempt <= REMOVE_MAX_ATTEMPTS; attempt++) {
      try {
        await git(args, repoDir);
        break;
      } catch (err) {
        if (!(err instanceof GitCommandError)) throw err;

        if (NOT_A_WORKING_TREE_ERROR.test(err.message) || NOT_A_WORKING_TREE_ERROR.test(err.stderr)) {
          // Already de-registered with git — not transient, no retry.
          // Recover best-effort and move on to the steps below.
          await recoverDeregisteredWorktree(git, repoDir, worktreePath);
          break;
        }

        if (!TRANSIENT_REMOVE_ERROR.test(err.message) && !TRANSIENT_REMOVE_ERROR.test(err.stderr)) {
          throw err;
        }

        if (attempt === REMOVE_MAX_ATTEMPTS) {
          if (await pathExists(worktreePath)) {
            throw new Error(
              `git worktree remove failed for "${worktreePath}" in "${repoDir}" after ${REMOVE_MAX_ATTEMPTS} attempts: ${err.message}`,
              { cause: err }
            );
          }
          break; // Gone despite the reported failure — idempotent success.
        }

        const backoff =
          REMOVE_RETRY_BACKOFF_MS[Math.min(attempt - 1, REMOVE_RETRY_BACKOFF_MS.length - 1)];
        await sleep(backoff);
      }
    }
  }

  if (deleteBranch && (await branchExists(git, repoDir, deleteBranch))) {
    // `--` guards against a `deleteBranch` value starting with `-` being
    // parsed as a flag instead of a ref (same class of issue as merge.ts).
    await git(["branch", "-D", "--", deleteBranch], repoDir);
  }

  await git(["worktree", "prune"], repoDir);
}
