import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../src/worktree/git.js";
import {
  createWorktree,
  listWorktrees,
  mergeBranch,
  removeWorktree,
  worktreePathFor
} from "../../src/worktree/index.js";

let root: string;
let repoDir: string;
let worktreesDir: string;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

beforeEach(async () => {
  root = join(tmpdir(), `agentic-os-worktree-test-${randomBytes(6).toString("hex")}`);
  repoDir = join(root, "repo");
  worktreesDir = join(root, "worktrees");
  await mkdir(repoDir, { recursive: true });

  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  // Pin line-ending handling so fixture content is byte-identical regardless
  // of the host's global core.autocrlf (Windows commonly defaults it true).
  await runGit(["config", "core.autocrlf", "false"], repoDir);

  await writeFile(join(repoDir, "file.txt"), "line1\n", "utf8");
  await runGit(["add", "file.txt"], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("worktreePathFor", () => {
  it("is deterministic for the same runId/workerId", () => {
    const a = worktreePathFor(worktreesDir, "run-1", "worker-1");
    const b = worktreePathFor(worktreesDir, "run-1", "worker-1");
    expect(a).toBe(b);
  });

  it("differs when runId or workerId differ", () => {
    const base = worktreePathFor(worktreesDir, "run-1", "worker-1");
    expect(worktreePathFor(worktreesDir, "run-2", "worker-1")).not.toBe(base);
    expect(worktreePathFor(worktreesDir, "run-1", "worker-2")).not.toBe(base);
  });

  it("produces short, Windows-safe path segments regardless of input length", () => {
    const longRunId = "r".repeat(500);
    const longWorkerId = "w".repeat(500);
    const p = worktreePathFor(worktreesDir, longRunId, longWorkerId);

    const rel = p.slice(worktreesDir.length + 1);
    const segments = rel.split(/[\\/]/);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("createWorktree / listWorktrees / removeWorktree roundtrip", () => {
  it("creates a worktree, lists it, then removes it", async () => {
    const wtPath = worktreePathFor(worktreesDir, "run-1", "worker-1");
    const info = await createWorktree({
      repoDir,
      worktreePath: wtPath,
      branchName: "worker/worker-1"
    });

    expect(info.worktreePath).toBe(wtPath);
    expect(info.branchName).toBe("worker/worker-1");
    expect(info.baseRef).toBe("HEAD");
    expect(info.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await pathExists(wtPath)).toBe(true);

    const listed = await listWorktrees(repoDir);
    const found = listed.find((w) => normalizePath(w.worktreePath) === normalizePath(wtPath));
    expect(found).toBeDefined();
    expect(found?.branchName).toBe("worker/worker-1");
    expect(found?.headSha).toBe(info.headSha);

    await removeWorktree({ repoDir, worktreePath: wtPath });
    expect(await pathExists(wtPath)).toBe(false);

    const listedAfter = await listWorktrees(repoDir);
    expect(listedAfter.some((w) => normalizePath(w.worktreePath) === normalizePath(wtPath))).toBe(
      false
    );
  });

  it("represents a detached-HEAD worktree with branchName undefined", async () => {
    const wtPath = worktreePathFor(worktreesDir, "run-detached", "worker-1");
    await createWorktree({ repoDir, worktreePath: wtPath, branchName: "worker/detach-source" });

    // Detach the worktree's HEAD.
    await runGit(["checkout", "--detach"], wtPath);

    const listed = await listWorktrees(repoDir);
    const found = listed.find((w) => normalizePath(w.worktreePath) === normalizePath(wtPath));
    expect(found).toBeDefined();
    expect(found?.branchName).toBeUndefined();

    await removeWorktree({ repoDir, worktreePath: wtPath, force: true });
  });

  it("is idempotent when the worktree path is already removed", async () => {
    const wtPath = worktreePathFor(worktreesDir, "run-2", "worker-1");
    await createWorktree({ repoDir, worktreePath: wtPath, branchName: "worker/idempotent" });
    await removeWorktree({ repoDir, worktreePath: wtPath });

    await expect(removeWorktree({ repoDir, worktreePath: wtPath })).resolves.toBeUndefined();
  });
});

describe("removeWorktree with a dirty worktree", () => {
  it("refuses without force and succeeds with force", async () => {
    const wtPath = worktreePathFor(worktreesDir, "run-3", "worker-1");
    await createWorktree({ repoDir, worktreePath: wtPath, branchName: "worker/dirty" });

    await writeFile(join(wtPath, "scratch.txt"), "uncommitted\n", "utf8");

    await expect(removeWorktree({ repoDir, worktreePath: wtPath })).rejects.toThrow();
    expect(await pathExists(wtPath)).toBe(true);

    await removeWorktree({ repoDir, worktreePath: wtPath, force: true });
    expect(await pathExists(wtPath)).toBe(false);
  });
});

describe("removeWorktree with deleteBranch", () => {
  it("deletes the branch after removing the worktree", async () => {
    const wtPath = worktreePathFor(worktreesDir, "run-4", "worker-1");
    await createWorktree({ repoDir, worktreePath: wtPath, branchName: "worker/deleteme" });

    await removeWorktree({ repoDir, worktreePath: wtPath, deleteBranch: "worker/deleteme" });

    const { stdout } = await runGit(["branch", "--list", "worker/deleteme"], repoDir);
    expect(stdout.trim()).toBe("");
  });

  it("tolerates a branch that is already gone", async () => {
    const wtPath = worktreePathFor(worktreesDir, "run-5", "worker-1");
    await createWorktree({ repoDir, worktreePath: wtPath, branchName: "worker/already-gone" });
    await removeWorktree({ repoDir, worktreePath: wtPath, deleteBranch: "worker/already-gone" });

    await expect(
      removeWorktree({ repoDir, worktreePath: wtPath, deleteBranch: "worker/already-gone" })
    ).resolves.toBeUndefined();
  });
});

describe("mergeBranch", () => {
  it("merges cleanly when there is no conflict", async () => {
    const wtPath = worktreePathFor(worktreesDir, "run-6", "worker-1");
    await createWorktree({ repoDir, worktreePath: wtPath, branchName: "feature/clean" });

    await writeFile(join(wtPath, "new-file.txt"), "hello\n", "utf8");
    await runGit(["add", "new-file.txt"], wtPath);
    await runGit(["commit", "-m", "add new-file.txt"], wtPath);

    const result = await mergeBranch({
      repoDir,
      sourceBranch: "feature/clean",
      targetBranch: "main"
    });

    expect(result.merged).toBe(true);
    if (result.merged) {
      expect(result.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    }

    const merged = await readFile(join(repoDir, "new-file.txt"), "utf8");
    expect(merged).toBe("hello\n");

    await removeWorktree({ repoDir, worktreePath: wtPath, deleteBranch: "feature/clean" });
  });

  it("reports conflictFiles and leaves the repo mergeable-clean on a real conflict", async () => {
    const wtA = worktreePathFor(worktreesDir, "run-7", "worker-a");
    const wtB = worktreePathFor(worktreesDir, "run-7", "worker-b");

    await createWorktree({ repoDir, worktreePath: wtA, branchName: "feature/a" });
    await createWorktree({ repoDir, worktreePath: wtB, branchName: "feature/b" });

    await writeFile(join(wtA, "file.txt"), "line1-from-a\n", "utf8");
    await runGit(["commit", "-am", "a changes line1"], wtA);

    await writeFile(join(wtB, "file.txt"), "line1-from-b\n", "utf8");
    await runGit(["commit", "-am", "b changes line1"], wtB);

    const first = await mergeBranch({ repoDir, sourceBranch: "feature/a", targetBranch: "main" });
    expect(first.merged).toBe(true);

    const second = await mergeBranch({ repoDir, sourceBranch: "feature/b", targetBranch: "main" });
    expect(second.merged).toBe(false);
    if (!second.merged) {
      expect(second.conflictFiles).toContain("file.txt");
    }

    // Left mergeable-clean: no MERGE_HEAD, no pending conflict in status.
    expect(await pathExists(join(repoDir, ".git", "MERGE_HEAD"))).toBe(false);
    const { stdout: status } = await runGit(["status", "--porcelain"], repoDir);
    expect(status.trim()).toBe("");

    const content = await readFile(join(repoDir, "file.txt"), "utf8");
    expect(content).toBe("line1-from-a\n");

    await removeWorktree({ repoDir, worktreePath: wtA, deleteBranch: "feature/a" });
    await removeWorktree({ repoDir, worktreePath: wtB, deleteBranch: "feature/b" });
  });
});
