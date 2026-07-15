export { GitCommandError, runGit } from "./git.js";
export type { GitResult } from "./git.js";
export { assertIsWorktreeRoot } from "./guard.js";
export { worktreePathFor } from "./paths.js";
export { createWorktree } from "./create.js";
export { listWorktrees } from "./list.js";
export { removeWorktree } from "./remove.js";
export { mergeBranch } from "./merge.js";
export type {
  WorktreeInfo,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  MergeBranchOptions,
  MergeResult
} from "./types.js";
