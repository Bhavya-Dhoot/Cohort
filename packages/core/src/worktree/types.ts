export interface WorktreeInfo {
  worktreePath: string;
  /** `undefined` when the worktree is in detached-HEAD state. */
  branchName: string | undefined;
  /** Only known when this info came from `createWorktree`; `git worktree list` doesn't report it. */
  baseRef?: string;
  headSha: string;
}

export interface CreateWorktreeOptions {
  repoDir: string;
  worktreePath: string;
  branchName: string;
  /** Defaults to "HEAD". */
  baseRef?: string;
}

export interface RemoveWorktreeOptions {
  repoDir: string;
  worktreePath: string;
  force?: boolean;
  /** Branch name to `git branch -D` after the worktree is removed. */
  deleteBranch?: string;
}

export interface MergeBranchOptions {
  repoDir: string;
  sourceBranch: string;
  targetBranch: string;
  message?: string;
}

export type MergeResult =
  | { merged: true; mergeSha: string }
  | { merged: false; conflictFiles: string[] };
