/**
 * Windows-safe resolution and detached spawning of the `opencode` binary.
 *
 * See docs-notes.md ("Executable resolution") for why this exists: `opencode`
 * on PATH resolves to a `.cmd` npm shim, and `child_process.spawn` throws
 * `EINVAL` synchronously if asked to exec a `.cmd`/`.bat` file without
 * `shell:true`. Rather than pay for a `cmd.exe` hop (an extra process in the
 * tree, and one more layer between us and the real PID for liveness checks /
 * `taskkill`), we read the shim and spawn its underlying `.exe` directly.
 * Falls back to `shell:true` only if that extraction fails.
 */

import { execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { OpencodeTransportError } from "./types.js";

const execFileAsync = promisify(execFile);

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ResolvedExecutable {
  cmd: string;
  /** true only when the shim couldn't be resolved to a real .exe. */
  shell: boolean;
}

/** Resolves `binaryPath` to something `child_process.spawn` can exec directly. */
export async function resolveExecutable(binaryPath: string): Promise<ResolvedExecutable> {
  if (process.platform !== "win32") {
    return { cmd: binaryPath, shell: false };
  }

  let candidate = binaryPath;
  if (!isAbsolute(candidate) && !/\.(exe|cmd|bat)$/i.test(candidate)) {
    candidate = (await resolveOnPath(candidate)) ?? candidate;
  }

  if (/\.(cmd|bat)$/i.test(candidate)) {
    const exe = await extractExeFromShim(candidate);
    if (exe) return { cmd: exe, shell: false };
    return { cmd: candidate, shell: true };
  }

  return { cmd: candidate, shell: false };
}

async function resolveOnPath(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("where", [name], { windowsHide: true });
    const lines = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? lines[0];
  } catch {
    return undefined;
  }
}

/** Extracts the `%dp0%\...\*.exe` target from an npm-generated .cmd shim. */
async function extractExeFromShim(shimPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(shimPath, "utf8");
    const marker = "%dp0%";
    const idx = content.indexOf(marker);
    if (idx === -1) return undefined;

    let rest = content.slice(idx + marker.length);
    const endQuote = rest.indexOf('"');
    const endLine = rest.indexOf("\n");
    const cut = endQuote !== -1 ? endQuote : endLine !== -1 ? endLine : rest.length;
    rest = rest.slice(0, cut).trim().replace(/^[\\/]/, "");

    if (!rest.toLowerCase().endsWith(".exe")) return undefined;
    const resolved = join(dirname(shimPath), rest);
    return existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export interface SpawnServerOptions {
  binaryPath: string;
  port: number;
  hostname: string;
  cwd: string;
  env?: Record<string, string>;
  logFile: string;
  spawnFn: SpawnFn;
}

/**
 * Spawns `opencode serve` detached (survives the caller's death) with
 * stdout/stderr redirected to `logFile`. Resolves once the OS confirms the
 * process actually started (the `spawn` event), not merely that the call
 * didn't throw synchronously — a `.cmd` shim misfire throws sync, but a bad
 * resolved path (ENOENT) only surfaces via the async `error` event.
 */
export async function spawnDetachedServer(opts: SpawnServerOptions): Promise<{ pid: number }> {
  const { cmd, shell } = await resolveExecutable(opts.binaryPath);
  await mkdir(dirname(opts.logFile), { recursive: true });
  const fd = openSync(opts.logFile, "a");

  try {
    const args = ["serve", "--port", String(opts.port), "--hostname", opts.hostname];
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;

    let child: ChildProcess;
    try {
      child = opts.spawnFn(cmd, args, {
        cwd: opts.cwd,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        shell
      });
    } catch (err) {
      throw new OpencodeTransportError(
        `failed to spawn "${cmd}": ${(err as Error).message}`,
        undefined,
        err
      );
    }

    await new Promise<void>((resolve, reject) => {
      child.once("error", (err) =>
        reject(new OpencodeTransportError(`opencode serve process error: ${err.message}`, undefined, err))
      );
      child.once("spawn", () => resolve());
    });

    if (child.pid === undefined) {
      throw new OpencodeTransportError("opencode serve spawned without a pid");
    }
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
}

/** `process.kill(pid, 0)` — works on Windows too (no signal is actually sent). */
export function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Binds an ephemeral port, closes the socket, and returns the port number. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("failed to determine a free port")));
      }
    });
  });
}

/**
 * Runs `opencode export <sessionID>` and returns its stdout (JSON). Used
 * only as a fallback for `getUsage` when the HTTP API is unreachable.
 */
export async function runOpencodeExport(binaryPath: string, sessionId: string): Promise<string> {
  const { cmd, shell } = await resolveExecutable(binaryPath);
  const { stdout } = await execFileAsync(cmd, ["export", sessionId], {
    windowsHide: true,
    shell,
    maxBuffer: 1024 * 1024 * 16
  });
  return stdout;
}
