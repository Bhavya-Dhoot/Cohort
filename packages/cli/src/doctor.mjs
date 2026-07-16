/**
 * `cohort doctor` / `cohort login` — verify the local environment is ready
 * to run Cohort, without ever printing or storing secret values (only
 * presence/OK/FAIL + remediation). Every external check goes through an
 * injected `exec` so tests never actually spawn `claude`/`opencode`.
 */
import { createExec } from "./exec.mjs";

const NODE_MIN_MAJOR = 22;

function nodeMajor(versionString) {
  return Number(String(versionString).replace(/^v/, "").split(".")[0]);
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
/** Anything this long and unbroken reads as a token/key, not a provider name — dropped defensively even though `auth list` isn't expected to print one. */
const KEY_LIKE_TOKEN_RE = /^[A-Za-z0-9_\-.]{20,}$/;

/**
 * Best-effort summary of `opencode auth list` output. Real output (as of
 * opencode 1.x) is an ANSI-styled tree: a "┌ Credentials <path>" header, one
 * "● <Provider Name> <auth type>" line per configured provider, and a
 * "└ N credentials" footer — this strips the ANSI codes, keeps only the "●"
 * provider lines, and drops any suspiciously long token from each (defense
 * in depth in case a future opencode version ever echoes part of a key).
 */
function summarizeAuthList(stdout) {
  const clean = stdout.replace(ANSI_ESCAPE_RE, "");
  const providers = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("●"))
    .map((line) =>
      line
        .slice(1)
        .trim()
        .split(/\s+/)
        .filter((tok) => tok && !KEY_LIKE_TOKEN_RE.test(tok))
        .join(" ")
    )
    .filter(Boolean);

  return providers.length > 0
    ? { ok: true, detail: `provider(s) configured: ${providers.join(", ")}` }
    : { ok: false, detail: "no providers configured" };
}

function printReport(checks, log) {
  log("");
  log("Cohort environment check:");
  for (const check of checks) {
    log(`  [${check.ok ? "OK" : "FAIL"}] ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    if (!check.ok && check.remediation) {
      log(`         -> ${check.remediation}`);
    }
  }
  log("");
}

/**
 * Runs every environment check and returns `{ ok, checks }` — `ok` is true
 * only if every check passed. Accepts injected `exec`/`nodeVersion`/`log` so
 * this is fully unit-testable without touching a real machine.
 */
export async function runDoctor(deps = {}) {
  const exec = deps.exec ?? createExec();
  const nodeVersion = deps.nodeVersion ?? process.version;
  const log = deps.log ?? console.log;

  const checks = [];

  const major = nodeMajor(nodeVersion);
  checks.push({
    name: `Node.js >= ${NODE_MIN_MAJOR}`,
    ok: Number.isFinite(major) && major >= NODE_MIN_MAJOR,
    detail: nodeVersion,
    remediation: "Install Node.js 22 or newer: https://nodejs.org/"
  });

  const claude = await exec("claude", ["--version"]);
  checks.push({
    name: "claude CLI (Claude Code — the loop engine)",
    ok: claude.ok,
    detail: claude.ok ? claude.stdout.trim().split(/\r?\n/)[0] : claude.notFound ? "not found on PATH" : "failed to run",
    remediation: "Install Claude Code: https://docs.claude.com/en/docs/claude-code/overview"
  });

  const opencode = await exec("opencode", ["--version"]);
  checks.push({
    name: "opencode CLI (worker runtime)",
    ok: opencode.ok,
    detail: opencode.ok ? opencode.stdout.trim().split(/\r?\n/)[0] : opencode.notFound ? "not found on PATH" : "failed to run",
    remediation: "Install OpenCode: https://opencode.ai"
  });

  let authResult = { ok: false, detail: "skipped (opencode CLI unavailable)" };
  if (opencode.ok) {
    const authList = await exec("opencode", ["auth", "list"]);
    authResult = authList.ok ? summarizeAuthList(authList.stdout) : { ok: false, detail: "could not run `opencode auth list`" };
  }
  checks.push({
    name: "OpenCode provider auth",
    ok: authResult.ok,
    detail: authResult.detail,
    remediation: "Run `opencode auth login` to authenticate a provider (see `cohort login`)."
  });

  printReport(checks, log);

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * `cohort login`: doctor's checklist plus, when OpenCode has no usable
 * provider, the exact `opencode auth login` command to run — cohort never
 * prompts for or captures an API key itself; the user authenticates through
 * OpenCode's own flow.
 */
export async function runLogin(deps = {}) {
  const log = deps.log ?? console.log;
  const result = await runDoctor(deps);

  const authCheck = result.checks.find((c) => c.name === "OpenCode provider auth");
  if (authCheck && !authCheck.ok) {
    log("OpenCode has no usable provider configured yet. Run this yourself to authenticate:");
    log("");
    log("  opencode auth login");
    log("");
    log("cohort does not prompt for or store API keys — authenticate via OpenCode's own flow above, then re-run `cohort login`.");
  }

  return result;
}
