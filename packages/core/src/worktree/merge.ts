import { GitCommandError, runGit } from "./git.js";
import type { MergeBranchOptions, MergeResult } from "./types.js";

/** Injectable seam for `runGit`, so tests can force a specific git call to fail deterministically. */
export type RunGitFn = typeof runGit;

/** `git merge --abort`'s message when there's genuinely nothing to abort (merge failed before MERGE_HEAD existed) — expected, not a failure of the abort itself. */
const ABORT_NOOP_PATTERN = /no merge to abort|merge_head missing/i;

async function conflictFiles(repoDir: string): Promise<string[]> {
  const { stdout } = await runGit(["diff", "--name-only", "--diff-filter=U"], repoDir);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Rejects anything that isn't a well-formed git branch name — in particular
 * anything starting with `-`, which `git switch`/`git merge` would otherwise
 * parse as a flag instead of a ref. Delegates the actual rule-checking to
 * `git check-ref-format` rather than reimplementing git's ref grammar.
 */
async function assertValidBranchName(
  git: RunGitFn,
  repoDir: string,
  name: string,
  label: string
): Promise<void> {
  try {
    await git(["check-ref-format", "--branch", name], repoDir);
  } catch (err) {
    throw new Error(
      `Invalid ${label} "${name}": not a valid git branch name (rejected by "git check-ref-format --branch")`,
      { cause: err }
    );
  }
}

/**
 * Merges `sourceBranch` into `targetBranch` inside `repoDir`.
 *
 * The caller guarantees `repoDir`'s working tree is clean before calling —
 * this switches branches and merges directly against it, with no stash or
 * other protection for uncommitted changes.
 *
 * `targetBranch`/`sourceBranch` are validated with `git check-ref-format
 * --branch` before anything touches the repo, and passed to `git switch`/
 * `git merge` after a `--` separator — both defend against a branch name
 * (e.g. `"--force"`) being parsed as a flag instead of a ref.
 *
 * On a real conflict, aborts the merge (leaving `repoDir` back on
 * `targetBranch` with no `MERGE_HEAD`) and returns the conflicting file
 * list instead of throwing. Any other git failure (e.g. an unknown branch)
 * still throws, since misreporting that as "conflict" would hide the real
 * problem. If the abort itself fails for a reason other than "nothing to
 * abort", that's surfaced as a combined error naming both the original
 * failure and the failed abort — the repo may be left mid-merge and needs
 * manual attention.
 */
export async function mergeBranch(
  opts: MergeBranchOptions,
  deps: { runGit?: RunGitFn } = {}
): Promise<MergeResult> {
  const { repoDir, sourceBranch, targetBranch } = opts;
  const git = deps.runGit ?? runGit;
  const message = opts.message ?? `Merge ${sourceBranch} into ${targetBranch}`;

  await assertValidBranchName(git, repoDir, targetBranch, "targetBranch");
  await assertValidBranchName(git, repoDir, sourceBranch, "sourceBranch");

  await git(["switch", "--", targetBranch], repoDir);

  try {
    await git(["merge", "--no-ff", "-m", message, "--", sourceBranch], repoDir);
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;

    const files = await conflictFiles(repoDir);

    try {
      await git(["merge", "--abort"], repoDir);
    } catch (abortErr) {
      const isExpectedNoOp =
        abortErr instanceof GitCommandError && ABORT_NOOP_PATTERN.test(abortErr.stderr);
      if (!isExpectedNoOp) {
        const abortMessage = abortErr instanceof Error ? abortErr.message : String(abortErr);
        throw new Error(
          `Merge of "${sourceBranch}" into "${targetBranch}" in "${repoDir}" failed (${err.message}), ` +
            `and the follow-up "git merge --abort" also failed (${abortMessage}). ` +
            `The repository may be left mid-merge and needs manual attention.`,
          { cause: err }
        );
      }
      // Nothing to abort (merge failed before creating MERGE_HEAD) — expected, ignore.
    }

    if (files.length === 0) {
      // Not actually a content conflict (e.g. bad branch name) — surface the
      // real error rather than reporting a phantom conflict.
      throw err;
    }
    return { merged: false, conflictFiles: files };
  }

  const { stdout } = await git(["rev-parse", "HEAD"], repoDir);
  return { merged: true, mergeSha: stdout.trim() };
}
