import { realpath } from "node:fs/promises";
import { runGit } from "./git.js";

/**
 * Normalizes a path for equality comparison across `\` vs `/` and (on
 * win32) case, so two paths that refer to the identical directory compare
 * equal regardless of which separator/casing style produced them. Only
 * applied after `fs.realpath` has already resolved symlinks/junctions and
 * (on Windows) 8.3 short names to their canonical long form — this function
 * alone is not a substitute for that resolution.
 */
function normalizeForCompare(path: string): string {
  const withForwardSlashes = path.replace(/\\/g, "/");
  return process.platform === "win32" ? withForwardSlashes.toLowerCase() : withForwardSlashes;
}

/**
 * Verifies that `worktreePath` is itself the root of a git worktree — i.e.
 * `git -C <worktreePath> rev-parse --show-toplevel` resolves back to
 * `worktreePath` itself, rather than to some enclosing repository that git
 * found by walking up parent directories.
 *
 * This exists because a directory can exist on disk at `worktreePath`
 * (e.g. left behind by a failed/partial `createWorktree`, or a
 * half-completed `removeWorktree`) without being a registered git worktree
 * at all. Git does not treat that as an error: `git -C <deadDir> <cmd>`
 * silently walks up the filesystem, finds the nearest ancestor `.git`, and
 * runs `<cmd>` against THAT repository instead. A read like `git status`
 * then reports garbage (someone else's repo state); a mutating command like
 * `git add -A && git commit` silently commits into that enclosing
 * repository — which, in production, has meant the platform repo itself.
 *
 * Must be called before any git command whose `cwd`/`-C` is a worker's
 * `worktreePath`, so that a dead/never-provisioned worktree fails loudly
 * here instead of git quietly operating on the wrong repository.
 *
 * Comparison is done via `fs.realpath` (resolves symlinks/junctions and, on
 * Windows, 8.3 short names) plus case/separator normalization, since
 * Windows path comparison can't rely on simple string equality: the same
 * directory can be spelled with `\` or `/`, in different case, or via a
 * short (8.3) alias.
 */
export async function assertIsWorktreeRoot(worktreePath: string): Promise<void> {
  let resolvedInput: string;
  try {
    resolvedInput = await realpath(worktreePath);
  } catch (err) {
    throw new Error(
      `Refusing to run git against worktree path '${worktreePath}': the path does not exist or is not ` +
        `accessible (${err instanceof Error ? err.message : String(err)}). It may have been partially ` +
        `removed, or never fully provisioned.`
    );
  }

  let toplevel: string;
  try {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], worktreePath);
    toplevel = stdout.trim();
  } catch (err) {
    throw new Error(
      `Refusing to run git against worktree path '${worktreePath}': 'git rev-parse --show-toplevel' failed, ` +
        `meaning this path is not inside any git repository at all ` +
        `(${err instanceof Error ? err.message : String(err)}).`
    );
  }

  let resolvedToplevel: string;
  try {
    resolvedToplevel = await realpath(toplevel);
  } catch (err) {
    throw new Error(
      `Refusing to run git against worktree path '${worktreePath}': git reported its toplevel as ` +
        `'${toplevel}', but that path could not be resolved ` +
        `(${err instanceof Error ? err.message : String(err)}).`
    );
  }

  if (normalizeForCompare(resolvedInput) !== normalizeForCompare(resolvedToplevel)) {
    throw new Error(
      `Refusing to run git against worktree path '${worktreePath}' (resolves to '${resolvedInput}'): ` +
        `'git -C ${worktreePath} rev-parse --show-toplevel' resolved to a DIFFERENT directory ` +
        `'${resolvedToplevel}'. This means '${worktreePath}' is not itself a git worktree root — git ` +
        `walked up the filesystem and found an ENCLOSING repository at '${resolvedToplevel}' instead. ` +
        `Running git commands here (especially mutating ones like commit) would silently operate on ` +
        `that enclosing repository rather than the intended worktree. This typically means the worktree ` +
        `was never fully provisioned, or was left behind by a partial removal.`
    );
  }
}
