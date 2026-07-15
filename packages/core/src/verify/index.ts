import { execFile, spawn, type ChildProcess } from "node:child_process";

/**
 * Options for {@link runVerification}.
 */
export interface RunVerificationOptions {
  /** Working directory to run `command` in — the worker's worktree. */
  cwd: string;
  /** A configured shell command, e.g. `"npm test"`. */
  command: string;
  /** Kill the command's whole process tree if it runs longer than this. Default 300_000 (5 min). */
  timeoutMs?: number;
  /** Truncate stdout/stderr independently once either exceeds this many bytes. Default 200_000. */
  maxOutputBytes?: number;
}

/**
 * Result of running a verification command. `passed` is the only field
 * callers should branch on; the rest is evidence for why.
 */
export interface VerifyResult {
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

/**
 * Runs a configured shell command against a worker's worktree and reports
 * whether it actually succeeded. This is the only source of truth for "did
 * the work pass" — per the architecture's "verification never trusts
 * self-report" principle, it never reads the worker's own transcript, only
 * the real process exit code and captured output.
 *
 * The command is executed via `child_process.spawn(command, { shell: true,
 * cwd })`. If it runs longer than `timeoutMs`, the entire process tree is
 * killed (on win32 via `taskkill /PID <pid> /T /F`, on POSIX by spawning
 * detached and signaling the whole process group) — a plain `child.kill()`
 * would leave grandchildren (e.g. the real process behind an `npm`/`cmd`
 * wrapper) running on Windows.
 */
export function runVerification(
  opts: RunVerificationOptions
): Promise<VerifyResult> {
  const { cwd, command } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const isWindows = process.platform === "win32";

  return new Promise<VerifyResult>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      // On POSIX, detaching makes `child.pid` the process-group leader so
      // `process.kill(-pid, ...)` reaches the whole tree. On Windows this
      // flag would pop a separate console instead, so tree-kill there goes
      // through `taskkill /T` instead (see killProcessTree below).
      detached: !isWindows,
      windowsHide: true
    });

    const stdout = makeOutputCollector(maxOutputBytes);
    const stderr = makeOutputCollector(maxOutputBytes);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child, isWindows);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    // On Windows, a bad cwd fires both "error" and "close" for the same
    // failed spawn; `settled` ensures only the first (the "error") settles
    // the promise, giving callers a clear rejection instead of a fabricated
    // VerifyResult.
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to run verification command "${command}" in "${cwd}": ${err.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        passed: code === 0 && !timedOut,
        exitCode: code,
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: stdout.truncated() || stderr.truncated()
      });
    });
  });
}

/**
 * Accumulates stream chunks into a string, stopping (without buffering
 * further text) once `limit` bytes have been seen. Every chunk still passes
 * through `push` so the stream keeps flowing and the child never blocks on
 * a full pipe buffer after truncation kicks in.
 */
function makeOutputCollector(limit: number): {
  push: (chunk: Buffer) => void;
  value: () => string;
  truncated: () => boolean;
} {
  let text = "";
  let bytes = 0;
  let isTruncated = false;

  return {
    push(chunk: Buffer): void {
      if (isTruncated) return;
      bytes += chunk.length;
      if (bytes > limit) {
        const allowed = chunk.length - (bytes - limit);
        if (allowed > 0) text += chunk.toString("utf8", 0, allowed);
        isTruncated = true;
      } else {
        text += chunk.toString("utf8");
      }
    },
    value: () => text,
    truncated: () => isTruncated
  };
}

/** Kills `child` and all of its descendants. See {@link runVerification}. */
async function killProcessTree(
  child: ChildProcess,
  isWindows: boolean
): Promise<void> {
  const pid = child.pid;
  if (pid == null) return;

  if (isWindows) {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Process (group) may already be gone; nothing further to do.
  }
}
