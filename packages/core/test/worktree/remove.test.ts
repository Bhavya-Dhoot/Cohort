import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCommandError } from "../../src/worktree/git.js";
import { removeWorktree } from "../../src/worktree/remove.js";
import type { RunGitFn } from "../../src/worktree/remove.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function permissionDeniedError(args: string[], cwd: string): GitCommandError {
  return new GitCommandError(
    `git ${args.join(" ")} failed in ${cwd}: Permission denied`,
    args,
    "error: unable to unlink 'file': Permission denied"
  );
}

let root: string;
let repoDir: string;
let worktreePath: string;

beforeEach(async () => {
  root = join(tmpdir(), `cohort-remove-test-${randomBytes(6).toString("hex")}`);
  repoDir = join(root, "repo");
  worktreePath = join(root, "worktree");
  await mkdir(repoDir, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("removeWorktree retry on transient failures", () => {
  it("transient-then-success: retries once and resolves", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    let removeCallCount = 0;

    const fakeRunGit: RunGitFn = async (args, cwd) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCallCount++;
        if (removeCallCount === 1) {
          throw permissionDeniedError(args, cwd);
        }
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };

    await removeWorktree(
      { repoDir, worktreePath },
      { runGit: fakeRunGit, sleep: fakeSleep }
    );

    expect(removeCallCount).toBe(2);
    expect(sleeps).toEqual([200]);
  });

  it("persistent-transient: rejects after 4 attempts naming the path and attempt count, without retrying forever", async () => {
    const sleeps: number[] = [];
    let removeCallCount = 0;

    const fakeRunGit: RunGitFn = async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCallCount++;
        throw permissionDeniedError(args, cwd);
      }
      return { stdout: "", stderr: "" };
    };
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };

    let caught: unknown;
    try {
      await removeWorktree({ repoDir, worktreePath }, { runGit: fakeRunGit, sleep: fakeSleep });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(worktreePath);
    expect(message).toContain("4 attempts");

    expect(removeCallCount).toBe(4);
    expect(sleeps).toEqual([200, 500, 1000]);
    // The real directory was never actually removed by the fake, so it must still exist.
    expect(await pathExists(worktreePath)).toBe(true);
  });

  it("non-transient: rejects immediately with only 1 attempt and no sleep", async () => {
    const sleeps: number[] = [];
    let removeCallCount = 0;

    const fakeRunGit: RunGitFn = async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCallCount++;
        throw new GitCommandError(
          `git ${args.join(" ")} failed in ${cwd}: fatal: bad revision '${worktreePath}'`,
          args,
          `fatal: bad revision '${worktreePath}'`
        );
      }
      return { stdout: "", stderr: "" };
    };
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };

    await expect(
      removeWorktree({ repoDir, worktreePath }, { runGit: fakeRunGit, sleep: fakeSleep })
    ).rejects.toThrow(/bad revision/i);

    expect(removeCallCount).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('not-a-working-tree: recovers (prune + rm) and resolves without retrying', async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    let removeCallCount = 0;
    let pruneCallCount = 0;

    const fakeRunGit: RunGitFn = async (args, cwd) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCallCount++;
        throw new GitCommandError(
          `git ${args.join(" ")} failed in ${cwd}: fatal: '${worktreePath}' is not a working tree`,
          args,
          `fatal: '${worktreePath}' is not a working tree`
        );
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        pruneCallCount++;
      }
      return { stdout: "", stderr: "" };
    };
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };

    await expect(
      removeWorktree({ repoDir, worktreePath }, { runGit: fakeRunGit, sleep: fakeSleep })
    ).resolves.toBeUndefined();

    // Single remove attempt: this is non-transient, so no retry loop.
    expect(removeCallCount).toBe(1);
    expect(sleeps).toEqual([]);
    // Best-effort recovery prune, plus the function's own final prune.
    expect(pruneCallCount).toBe(2);
    // The leftover directory was removed directly via fs.rm.
    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("gone-after-failure: resolves when the path disappears despite continued transient failures", async () => {
    const sleeps: number[] = [];
    let removeCallCount = 0;

    const fakeRunGit: RunGitFn = async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removeCallCount++;
        // Simulate a removal that partially succeeded on disk before the
        // reported (transient) failure — e.g. the dir was unlinked but a
        // trailing metadata write in `.git/worktrees/*` then failed.
        await rm(worktreePath, { recursive: true, force: true });
        throw permissionDeniedError(args, cwd);
      }
      return { stdout: "", stderr: "" };
    };
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };

    await expect(
      removeWorktree({ repoDir, worktreePath }, { runGit: fakeRunGit, sleep: fakeSleep })
    ).resolves.toBeUndefined();

    expect(removeCallCount).toBe(4);
    expect(sleeps).toEqual([200, 500, 1000]);
    expect(await pathExists(worktreePath)).toBe(false);
  });
});

describe("removeWorktree happy path", () => {
  it("succeeds on the first try, deletes the branch, and prunes", async () => {
    const calls: string[][] = [];
    const fakeRunGit: RunGitFn = async (args, cwd) => {
      calls.push(args);
      if (args[0] === "rev-parse") {
        // Branch exists.
        return { stdout: "abc123\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    await removeWorktree(
      { repoDir, worktreePath, deleteBranch: "worker/done" },
      { runGit: fakeRunGit, sleep: async () => {} }
    );

    expect(calls[0]).toEqual(["worktree", "remove", worktreePath]);
    expect(calls.some((c) => c[0] === "branch" && c[1] === "-D")).toBe(true);
    expect(calls[calls.length - 1]).toEqual(["worktree", "prune"]);
  });
});
