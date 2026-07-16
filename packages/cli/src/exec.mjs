/**
 * Runs a command without throwing, so callers (doctor checks) can branch on
 * "not installed" vs. "installed but errored" vs. "ok" without try/catch at
 * every call site. On win32, many CLIs installed via npm are `.cmd` shims;
 * `child_process.execFile` without `shell:true` fails those with `EINVAL`
 * (see packages/core/src/opencode-client/binary.ts's docstring for the full
 * story), so this always shells out on Windows. That's fine here — these are
 * short-lived `--version`/`auth list` calls, not the long-lived detached
 * server binary.ts has to manage.
 */
import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Returns a real `exec(cmd, args)` implementation; override in tests with a fake. */
export function createExec() {
  return function exec(cmd, args, options = {}) {
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          windowsHide: true,
          timeout: DEFAULT_TIMEOUT_MS,
          shell: process.platform === "win32",
          ...options
        },
        (error, stdout, stderr) => {
          if (error) {
            const notFound = error.code === "ENOENT" || /not recognized|command not found/i.test(String(error.message));
            resolve({ ok: false, notFound, stdout: stdout?.toString() ?? "", stderr: (stderr?.toString() ?? "") || String(error.message) });
          } else {
            resolve({ ok: true, notFound: false, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
          }
        }
      );
    });
  };
}
