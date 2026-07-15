import { runGit } from "./git.js";
import type { WorktreeInfo } from "./types.js";

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Lists all worktrees registered against `repoDir` by parsing
 * `git worktree list --porcelain`. Detached-HEAD worktrees are represented
 * with `branchName: undefined`.
 */
export async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]> {
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], repoDir);

  const blocks = stdout
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const results: WorktreeInfo[] = [];
  for (const block of blocks) {
    let worktreePath: string | undefined;
    let headSha = "";
    let branchName: string | undefined;

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        branchName = ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref;
      } else if (line === "detached") {
        branchName = undefined;
      }
    }

    if (worktreePath) {
      results.push({ worktreePath, branchName, headSha });
    }
  }

  return results;
}
