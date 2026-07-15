import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveExecutable } from "../../src/opencode-client/binary.js";

/**
 * Fixture shims replicating the ACTUAL npm .cmd shim structures found on
 * this machine (`C:\Users\...\AppData\Roaming\npm\*.cmd`), not a simplified
 * approximation:
 *
 * - opencode.cmd: a single-line shim with no node-detection preamble, one
 *   `%dp0%` reference pointing straight at the target .exe.
 * - npm.cmd / gemini.cmd: the standard npm cmd-shim template for
 *   JS-entrypoint CLIs, with a node-detection preamble (`IF EXIST
 *   "%dp0%\node.exe" (...)`) before the real invocation line -- two
 *   `%dp0%` references, where the FIRST one resolves to node.exe rather
 *   than the target.
 */
const SINGLE_LINE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  ""
].join("\r\n");

const NODE_PREAMBLE_SHIM = (jsRelPath: string) =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${jsRelPath}" %*`,
    ""
  ].join("\r\n");

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `agentic-os-binary-test-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("resolveExecutable - .cmd shim parsing", () => {
  it("resolves a single-line shim (opencode.cmd shape) to its .exe target", async () => {
    const shimPath = join(dir, "opencode.cmd");
    const exeDir = join(dir, "node_modules", "opencode-ai", "bin");
    await mkdir(exeDir, { recursive: true });
    const exePath = join(exeDir, "opencode.exe");
    await writeFile(exePath, "", "utf8");
    await writeFile(shimPath, SINGLE_LINE_SHIM, "utf8");

    await expect(resolveExecutable(shimPath)).resolves.toEqual({ cmd: exePath, shell: false });
  });

  it("falls back to shell:true for the standard npm node-detection shim, even when node.exe is co-located (the historical first-%dp0%-occurrence bug)", async () => {
    const shimPath = join(dir, "npm.cmd");
    // Simulate an nvm-windows/Volta-style layout where node.exe DOES sit
    // next to the shim -- exactly the layout that made the old
    // first-%dp0%-occurrence parser misresolve to node.exe instead of
    // falling back.
    await writeFile(join(dir, "node.exe"), "", "utf8");
    const jsDir = join(dir, "node_modules", "npm", "bin");
    await mkdir(jsDir, { recursive: true });
    await writeFile(join(jsDir, "npm-cli.js"), "", "utf8");
    await writeFile(shimPath, NODE_PREAMBLE_SHIM("node_modules\\npm\\bin\\npm-cli.js"), "utf8");

    await expect(resolveExecutable(shimPath)).resolves.toEqual({ cmd: shimPath, shell: true });
  });

  it("falls back to shell:true for a garbage shim with no resolvable target", async () => {
    const shimPath = join(dir, "garbage.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho this is not a real shim\r\n", "utf8");

    await expect(resolveExecutable(shimPath)).resolves.toEqual({ cmd: shimPath, shell: true });
  });

  it("falls back to shell:true when the extracted target doesn't exist on disk", async () => {
    const shimPath = join(dir, "opencode.cmd");
    // No node_modules/opencode-ai/bin/opencode.exe created -- extraction
    // succeeds syntactically but the resolved path is missing.
    await writeFile(shimPath, SINGLE_LINE_SHIM, "utf8");

    await expect(resolveExecutable(shimPath)).resolves.toEqual({ cmd: shimPath, shell: true });
  });
});
