import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runGit } from "./git.js";
import type { CreateWorktreeOptions, WorktreeInfo } from "./types.js";

/**
 * Creates a new git worktree with a new branch.
 *
 * Sets `core.longpaths true` on the repo first — worktree admin data lives
 * under `.git/worktrees/<name>/...` and combined with a deep worktree path
 * can exceed Windows' legacy MAX_PATH otherwise. Parent directories of
 * `worktreePath` are created if missing (git does not reliably do this
 * across versions/platforms).
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const { repoDir, worktreePath, branchName } = opts;
  const baseRef = opts.baseRef ?? "HEAD";

  await runGit(["config", "core.longpaths", "true"], repoDir);
  await mkdir(dirname(worktreePath), { recursive: true });
  await runGit(["worktree", "add", "-b", branchName, worktreePath, baseRef], repoDir);

  const { stdout } = await runGit(["rev-parse", "HEAD"], worktreePath);

  return { worktreePath, branchName, baseRef, headSha: stdout.trim() };
}
