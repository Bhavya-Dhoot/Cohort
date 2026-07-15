import { stat } from "node:fs/promises";
import { GitCommandError, runGit } from "./git.js";
import type { RemoveWorktreeOptions } from "./types.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoDir: string, branchName: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], repoDir);
    return true;
  } catch (err) {
    if (err instanceof GitCommandError) return false;
    throw err;
  }
}

/**
 * Removes a worktree and (optionally) force-deletes its branch, then prunes
 * stale worktree admin metadata. Idempotent: if `worktreePath` no longer
 * exists on disk, or `deleteBranch` no longer exists (e.g. a previous call
 * already removed them), those steps are skipped rather than erroring.
 */
export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { repoDir, worktreePath, force, deleteBranch } = opts;

  if (await pathExists(worktreePath)) {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    await runGit(args, repoDir);
  }

  if (deleteBranch && (await branchExists(repoDir, deleteBranch))) {
    await runGit(["branch", "-D", deleteBranch], repoDir);
  }

  await runGit(["worktree", "prune"], repoDir);
}
