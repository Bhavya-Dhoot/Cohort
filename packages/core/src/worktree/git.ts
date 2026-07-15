import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Thrown when a `git` invocation exits non-zero. The message always embeds
 * the command and git's own stderr so callers (and test failures) see the
 * real reason without needing to unwrap a nested error.
 */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs `git <args>` in `cwd` via `execFile` (never a shell — args are passed
 * as an array, so nothing here is vulnerable to shell interpolation). On
 * failure, throws `GitCommandError` with git's stderr embedded in the
 * message.
 */
export async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFile("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const stderr = e.stderr ?? "";
    throw new GitCommandError(
      `git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || e.message}`,
      args,
      stderr,
      err
    );
  }
}
