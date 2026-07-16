import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../src/worktree/git.js";
import {
  ensureIntegrationBranch,
  integrationBranchName,
  mergeInDagOrder
} from "../../src/worktree/index.js";

let root: string;
let repoDir: string;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = join(tmpdir(), `cohort-integration-test-${randomBytes(6).toString("hex")}`);
  repoDir = join(root, "repo");
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

describe("integrationBranchName", () => {
  it("namespaces under cohort/integration/", () => {
    expect(integrationBranchName("run-1")).toBe("cohort/integration/run-1");
  });

  it("sanitizes characters that aren't valid in a ref segment", () => {
    expect(integrationBranchName("run 1/weird*chars?")).toBe(
      "cohort/integration/run-1-weird-chars"
    );
  });
});

describe("ensureIntegrationBranch", () => {
  it("creates the branch from baseRef, then reuses it without disturbing HEAD", async () => {
    const { stdout: headBefore } = await runGit(["rev-parse", "HEAD"], repoDir);
    const { stdout: branchBefore } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);

    const first = await ensureIntegrationBranch({ repoDir, runId: "run-1", baseRef: "main" });
    expect(first.branchName).toBe("cohort/integration/run-1");
    expect(first.created).toBe(true);

    const exists = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${first.branchName}`],
      repoDir
    )
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    // HEAD/current branch untouched by creation.
    const { stdout: headAfterCreate } = await runGit(["rev-parse", "HEAD"], repoDir);
    const { stdout: branchAfterCreate } = await runGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      repoDir
    );
    expect(headAfterCreate).toBe(headBefore);
    expect(branchAfterCreate).toBe(branchBefore);

    const second = await ensureIntegrationBranch({ repoDir, runId: "run-1", baseRef: "main" });
    expect(second.branchName).toBe("cohort/integration/run-1");
    expect(second.created).toBe(false);

    // Still on the same branch/commit after the reuse call.
    const { stdout: headAfterReuse } = await runGit(["rev-parse", "HEAD"], repoDir);
    const { stdout: branchAfterReuse } = await runGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      repoDir
    );
    expect(headAfterReuse).toBe(headBefore);
    expect(branchAfterReuse).toBe(branchBefore);
  });

  it("branches from the given baseRef, not from HEAD", async () => {
    // Create a divergent branch with an extra commit, distinct from main.
    await runGit(["branch", "other-base"], repoDir);
    await runGit(["switch", "other-base"], repoDir);
    await writeFile(join(repoDir, "other.txt"), "other\n", "utf8");
    await runGit(["add", "other.txt"], repoDir);
    await runGit(["commit", "-m", "extra commit on other-base"], repoDir);
    const { stdout: otherBaseSha } = await runGit(["rev-parse", "other-base"], repoDir);
    await runGit(["switch", "main"], repoDir);

    const result = await ensureIntegrationBranch({
      repoDir,
      runId: "run-2",
      baseRef: "other-base"
    });
    expect(result.created).toBe(true);

    const { stdout: branchSha } = await runGit(["rev-parse", result.branchName], repoDir);
    expect(branchSha).toBe(otherBaseSha);
  });
});

describe("mergeInDagOrder", () => {
  it("merges independent branches in order onto the integration branch", async () => {
    await runGit(["branch", "feature/a", "main"], repoDir);
    await runGit(["branch", "feature/b", "main"], repoDir);

    await runGit(["switch", "feature/a"], repoDir);
    await writeFile(join(repoDir, "a.txt"), "from a\n", "utf8");
    await runGit(["add", "a.txt"], repoDir);
    await runGit(["commit", "-m", "add a.txt"], repoDir);

    await runGit(["switch", "feature/b"], repoDir);
    await writeFile(join(repoDir, "b.txt"), "from b\n", "utf8");
    await runGit(["add", "b.txt"], repoDir);
    await runGit(["commit", "-m", "add b.txt"], repoDir);

    await runGit(["switch", "main"], repoDir);

    const { branchName } = await ensureIntegrationBranch({
      repoDir,
      runId: "run-happy",
      baseRef: "main"
    });

    const result = await mergeInDagOrder({
      repoDir,
      integrationBranch: branchName,
      merges: [
        { taskId: "task-a", sourceBranch: "feature/a" },
        { taskId: "task-b", sourceBranch: "feature/b" }
      ]
    });

    expect(result.allMerged).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ taskId: "task-a", outcome: "merged" });
    expect(result.results[1]).toMatchObject({ taskId: "task-b", outcome: "merged" });
    expect(result.results[0]?.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.results[1]?.mergeSha).toMatch(/^[0-9a-f]{40}$/);

    await runGit(["switch", branchName], repoDir);
    const aContent = await readFile(join(repoDir, "a.txt"), "utf8");
    const bContent = await readFile(join(repoDir, "b.txt"), "utf8");
    expect(aContent).toBe("from a\n");
    expect(bContent).toBe("from b\n");
    await runGit(["switch", "main"], repoDir);
  });

  it("stops on the first conflict and skips the rest, leaving the repo clean", async () => {
    await runGit(["branch", "feature/x", "main"], repoDir);
    await runGit(["branch", "feature/y", "main"], repoDir);
    await runGit(["branch", "feature/z", "main"], repoDir);

    await runGit(["switch", "feature/x"], repoDir);
    await writeFile(join(repoDir, "file.txt"), "line1-from-x\n", "utf8");
    await runGit(["commit", "-am", "x changes line1"], repoDir);

    await runGit(["switch", "feature/y"], repoDir);
    await writeFile(join(repoDir, "file.txt"), "line1-from-y\n", "utf8");
    await runGit(["commit", "-am", "y changes line1"], repoDir);

    await runGit(["switch", "feature/z"], repoDir);
    await writeFile(join(repoDir, "z.txt"), "from z\n", "utf8");
    await runGit(["add", "z.txt"], repoDir);
    await runGit(["commit", "-m", "add z.txt"], repoDir);

    await runGit(["switch", "main"], repoDir);

    const { branchName } = await ensureIntegrationBranch({
      repoDir,
      runId: "run-conflict",
      baseRef: "main"
    });

    const result = await mergeInDagOrder({
      repoDir,
      integrationBranch: branchName,
      merges: [
        { taskId: "task-x", sourceBranch: "feature/x" },
        { taskId: "task-y", sourceBranch: "feature/y" },
        { taskId: "task-z", sourceBranch: "feature/z" }
      ]
    });

    expect(result.allMerged).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({ taskId: "task-x", outcome: "merged" });
    expect(result.results[1].outcome).toBe("conflict");
    expect(result.results[1].conflictFiles).toContain("file.txt");
    expect(result.results[2]).toMatchObject({ taskId: "task-z", outcome: "skipped" });

    // Repo left clean/no MERGE_HEAD.
    expect(await pathExists(join(repoDir, ".git", "MERGE_HEAD"))).toBe(false);
    const { stdout: status } = await runGit(["status", "--porcelain"], repoDir);
    expect(status.trim()).toBe("");
  });

  it("returns allMerged true for an empty merges list", async () => {
    const { branchName } = await ensureIntegrationBranch({
      repoDir,
      runId: "run-empty",
      baseRef: "main"
    });

    const result = await mergeInDagOrder({ repoDir, integrationBranch: branchName, merges: [] });

    expect(result.allMerged).toBe(true);
    expect(result.results).toEqual([]);
  });
});
