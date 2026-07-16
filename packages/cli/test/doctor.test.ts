import { describe, expect, it } from "vitest";
import { runDoctor, runLogin } from "../src/doctor.mjs";

/** Fake `exec` keyed by "cmd args.join(' ')"; never spawns a real process. */
function fakeExec(table: Record<string, { ok: boolean; notFound?: boolean; stdout?: string; stderr?: string }>) {
  return async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    const entry = table[key];
    if (!entry) {
      return { ok: false, notFound: true, stdout: "", stderr: `unexpected call: ${key}` };
    }
    return { ok: entry.ok, notFound: entry.notFound ?? false, stdout: entry.stdout ?? "", stderr: entry.stderr ?? "" };
  };
}

function collectLog() {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

// Mirrors real `opencode auth list` output: an ANSI-styled tree with a
// "┌ Credentials <path>" header, one "● <Provider> <type>" line per
// configured provider, and a "└ N credentials" footer.
const AUTH_LIST_STDOUT =
  "\x1b[90m┌\x1b[39m  Credentials \x1b[90m~/.local/share/opencode/auth.json\n" +
  "\x1b[90m│\x1b[39m\n" +
  "\x1b[34m●\x1b[39m  GitHub Copilot \x1b[90moauth\n" +
  "\x1b[90m│\x1b[39m\n" +
  "\x1b[90m└\x1b[39m  1 credentials\n";

const ALL_OK_TABLE = {
  "claude --version": { ok: true, stdout: "2.1.211 (Claude Code)\n" },
  "opencode --version": { ok: true, stdout: "1.15.13\n" },
  "opencode auth list": { ok: true, stdout: AUTH_LIST_STDOUT }
};

describe("runDoctor", () => {
  it("passes every check and returns ok:true when the environment is fully set up", async () => {
    const { log, lines } = collectLog();
    const result = await runDoctor({ exec: fakeExec(ALL_OK_TABLE), nodeVersion: "v22.17.1", log });

    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "Node.js >= 22",
      "claude CLI (Claude Code — the loop engine)",
      "opencode CLI (worker runtime)",
      "OpenCode provider auth"
    ]);
    expect(lines.some((l) => l.includes("[OK]"))).toBe(true);
  });

  it("fails with a remediation when claude is missing, and returns a non-zero-worthy ok:false", async () => {
    const table = { ...ALL_OK_TABLE };
    delete (table as any)["claude --version"];
    const exec = async (cmd: string, args: string[]) => {
      if (cmd === "claude") return { ok: false, notFound: true, stdout: "", stderr: "" };
      return fakeExec(ALL_OK_TABLE)(cmd, args);
    };

    const { log, lines } = collectLog();
    const result = await runDoctor({ exec, nodeVersion: "v22.17.1", log });

    expect(result.ok).toBe(false);
    const claudeCheck = result.checks.find((c) => c.name.startsWith("claude CLI"));
    expect(claudeCheck?.ok).toBe(false);
    expect(claudeCheck?.detail).toBe("not found on PATH");
    expect(claudeCheck?.remediation).toMatch(/install/i);
    expect(lines.some((l) => l.includes("FAIL") && l.includes("claude CLI"))).toBe(true);
    expect(lines.some((l) => l.includes("->"))).toBe(true);
  });

  it("fails Node.js check when the injected version is below 22", async () => {
    const result = await runDoctor({ exec: fakeExec(ALL_OK_TABLE), nodeVersion: "v18.20.0", log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name.startsWith("Node.js"))?.ok).toBe(false);
  });

  it("reports the configured provider name without leaking any key-like token", async () => {
    const result = await runDoctor({ exec: fakeExec(ALL_OK_TABLE), nodeVersion: "v22.17.1", log: () => {} });
    const authCheck = result.checks.find((c) => c.name === "OpenCode provider auth");
    expect(authCheck?.ok).toBe(true);
    expect(authCheck?.detail).toContain("GitHub Copilot");
  });

  it("never includes a secret-looking token even if opencode ever echoed one on a provider line", async () => {
    const table = {
      ...ALL_OK_TABLE,
      "opencode auth list": { ok: true, stdout: "\x1b[34m●\x1b[39m  anthropic sk-ant-super-secret-key-should-not-appear\n" }
    };
    const result = await runDoctor({ exec: fakeExec(table), nodeVersion: "v22.17.1", log: () => {} });
    const authCheck = result.checks.find((c) => c.name === "OpenCode provider auth");
    expect(authCheck?.detail).not.toContain("sk-ant-super-secret-key-should-not-appear");
  });
});

describe("runLogin", () => {
  it("prints the exact `opencode auth login` command when no provider is authed", async () => {
    const table = {
      "claude --version": { ok: true, stdout: "2.1.211\n" },
      "opencode --version": { ok: true, stdout: "1.15.13\n" },
      "opencode auth list": { ok: true, stdout: "" }
    };
    const { log, lines } = collectLog();
    const result = await runLogin({ exec: fakeExec(table), nodeVersion: "v22.17.1", log });

    expect(result.ok).toBe(false);
    expect(lines.some((l) => l.trim() === "opencode auth login")).toBe(true);
  });

  it("does not print the login command when a provider is already authed", async () => {
    const { log, lines } = collectLog();
    const result = await runLogin({ exec: fakeExec(ALL_OK_TABLE), nodeVersion: "v22.17.1", log });

    expect(result.ok).toBe(true);
    expect(lines.some((l) => l.trim() === "opencode auth login")).toBe(false);
  });
});
