import { GitCommandError, runGit } from "./git.js";
import type { MergeBranchOptions, MergeResult } from "./types.js";

async function conflictFiles(repoDir: string): Promise<string[]> {
  const { stdout } = await runGit(["diff", "--name-only", "--diff-filter=U"], repoDir);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Merges `sourceBranch` into `targetBranch` inside `repoDir`.
 *
 * The caller guarantees `repoDir`'s working tree is clean before calling —
 * this switches branches and merges directly against it, with no stash or
 * other protection for uncommitted changes.
 *
 * On a real conflict, aborts the merge (leaving `repoDir` back on
 * `targetBranch` with no `MERGE_HEAD`) and returns the conflicting file
 * list instead of throwing. Any other git failure (e.g. an unknown branch)
 * still throws, since misreporting that as "conflict" would hide the real
 * problem.
 */
export async function mergeBranch(opts: MergeBranchOptions): Promise<MergeResult> {
  const { repoDir, sourceBranch, targetBranch } = opts;
  const message = opts.message ?? `Merge ${sourceBranch} into ${targetBranch}`;

  await runGit(["switch", targetBranch], repoDir);

  try {
    await runGit(["merge", "--no-ff", sourceBranch, "-m", message], repoDir);
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;

    const files = await conflictFiles(repoDir);
    await runGit(["merge", "--abort"], repoDir).catch(() => {
      // Nothing to abort (merge failed before creating MERGE_HEAD) — ignore.
    });

    if (files.length === 0) {
      // Not actually a content conflict (e.g. bad branch name) — surface the
      // real error rather than reporting a phantom conflict.
      throw err;
    }
    return { merged: false, conflictFiles: files };
  }

  const { stdout } = await runGit(["rev-parse", "HEAD"], repoDir);
  return { merged: true, mergeSha: stdout.trim() };
}
