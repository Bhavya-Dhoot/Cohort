import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Dynamic generation/retirement of OpenCode specialist agents: markdown
 * files with YAML frontmatter at `<projectDir>/.opencode/agent/<id>.md`
 * (OpenCode's own agent-file format -- see
 * `../opencode-client/docs-notes.md` for how this repo verified adjacent
 * OpenCode HTTP/CLI behavior). Frontmatter fields: `description`, `mode`,
 * `model`/`temperature`/`steps` (all optional -- omitting `model` makes the
 * agent inherit its caller's model), and `permission` (tool/command glob ->
 * allow|ask|deny). The document body (everything after the closing `---`)
 * is the agent's system prompt.
 *
 * `role` and `generatedBy` are not OpenCode-recognized frontmatter keys;
 * they are stashed there anyway so `listSpecialists` can report them back
 * without a second store -- OpenCode ignores frontmatter keys it doesn't
 * recognize, so this is a safe place to keep them. `generatedBy` is this
 * module's provenance marker: `retireSpecialist` refuses to delete a file
 * that lacks it, so a hand-authored OpenCode agent file sharing an agentId
 * is never destroyed.
 *
 * Safety floor: `agents.yaml`'s `default_permission.deny` must appear as
 * `deny` in every generated agent's `permission` map regardless of what the
 * spec asks for -- see `mergePermission`.
 */

export type SpecialistMode = "subagent" | "primary" | "all";
export type PermissionValue = "allow" | "ask" | "deny";

export interface SpecialistSpec {
  /** Path-safe id; also the filename stem. Must match `AGENT_ID_RE`. */
  agentId: string;
  /** Human-readable role label, e.g. "OAuth Engineer". Stashed in frontmatter for listSpecialists. */
  role: string;
  /** Shown to OpenCode's agent selector to decide when to route to this specialist. */
  description: string;
  /** The agent's system prompt; becomes the markdown body. */
  systemPrompt: string;
  mode?: SpecialistMode;
  model?: string;
  temperature?: number;
  steps?: number;
  permission?: Record<string, PermissionValue>;
}

export interface GenerateSpecialistOptions {
  projectDir: string;
  spec: SpecialistSpec;
  /** Command globs from `agents.yaml` `default_permission.deny` -- always wins over `spec.permission`. */
  denyFloor: string[];
  /** Replace an existing agent file with the same id. Default false (duplicates rejected). */
  overwrite?: boolean;
}

export interface GenerateSpecialistResult {
  agentId: string;
  path: string;
}

export interface RetireSpecialistOptions {
  projectDir: string;
  agentId: string;
}

export interface RetireSpecialistResult {
  removed: boolean;
  /** Present (only) when `removed` is false because the file exists but lacks this module's `generatedBy` marker. */
  reason?: string;
}

export interface ListedSpecialist {
  agentId: string;
  role?: string;
  path: string;
  /** Whether the file carries this module's `generatedBy` marker, i.e. whether `retireSpecialist` would remove it. */
  generatedByUs: boolean;
}

/** Same shape as memory's section-name rule: lowercase, digits, hyphens, <=41 chars, path-safe. */
const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * Frontmatter marker value stamped by `renderAgentFile` on every file this
 * module generates. `retireSpecialist` checks for this before deleting, so
 * it never removes a hand-authored `.opencode/agent/*.md` file that happens
 * to share an agentId -- `.opencode/agent/` is OpenCode's own directory,
 * not one exclusively owned by this system.
 */
const GENERATED_BY = "cohort";

function assertValidAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`Invalid agentId "${agentId}": must match ${AGENT_ID_RE}`);
  }
}

function agentDir(projectDir: string): string {
  return join(projectDir, ".opencode", "agent");
}

function agentPath(projectDir: string, agentId: string): string {
  return join(agentDir(projectDir), `${agentId}.md`);
}

/**
 * Defense-in-depth beyond `assertValidAgentId`: confirms the resolved file
 * path is actually inside `<projectDir>/.opencode/agent` before any fs
 * write/delete. `AGENT_ID_RE` already forbids `/`, `\`, and `.`, so this
 * should never trip in practice -- it exists so a future loosening of the
 * regex can't silently reopen path traversal.
 */
function assertContained(projectDir: string, filePath: string): void {
  const dir = resolvePath(agentDir(projectDir));
  const resolved = resolvePath(filePath);
  const rel = relative(dir, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to touch path outside .opencode/agent: ${filePath}`);
  }
}

/**
 * True if `pattern` (a `denyFloor` entry) covers `key` (a spec permission
 * key): either the same literal string, or `pattern` is a `<literal>*`
 * prefix glob whose literal part is a prefix of `key`. This is a minimal
 * prefix-glob match, not a full glob library -- it's sufficient because
 * every `denyFloor` entry is shaped that way (see `agents.yaml`'s
 * `default_permission.deny`), but it does not handle a wildcard on the
 * spec's side (e.g. spec key `"git *"` is not recognized as covering/being
 * covered by floor `"git push*"`).
 */
function isCoveredByFloor(key: string, pattern: string): boolean {
  if (pattern === key) return true;
  return pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1));
}

/**
 * Denies from `denyFloor` always win. Any spec permission key that a floor
 * glob covers (per `isCoveredByFloor`) is dropped before the floor is
 * applied -- otherwise a spec key like `"git push"` would coexist with the
 * floor's `"git push*": "deny"` as two separate, contradictory rules for
 * overlapping commands in the rendered permission map.
 */
function mergePermission(
  specPermission: Record<string, PermissionValue> | undefined,
  denyFloor: string[]
): Record<string, PermissionValue> {
  const merged: Record<string, PermissionValue> = {};
  for (const [key, value] of Object.entries(specPermission ?? {})) {
    if (denyFloor.some((pattern) => isCoveredByFloor(key, pattern))) continue;
    merged[key] = value;
  }
  for (const cmd of denyFloor) {
    merged[cmd] = "deny";
  }
  return merged;
}

/**
 * Pure rendering of an agent spec into OpenCode's markdown+frontmatter
 * format. No fs access, no agentId validation (callers that touch disk --
 * `generateSpecialist` -- validate before calling this).
 */
export function renderAgentFile(spec: SpecialistSpec, denyFloor: string[]): string {
  const frontmatter: Record<string, unknown> = {
    description: spec.description,
    role: spec.role,
    mode: spec.mode ?? "subagent",
    generatedBy: GENERATED_BY
  };
  if (spec.model !== undefined) frontmatter.model = spec.model;
  if (spec.temperature !== undefined) frontmatter.temperature = spec.temperature;
  frontmatter.permission = mergePermission(spec.permission, denyFloor);
  if (spec.steps !== undefined) frontmatter.steps = spec.steps;

  const yamlText = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yamlText}\n---\n\n${spec.systemPrompt}\n`;
}

/** Atomic same-dir temp-file + rename, mirroring `lib/fs.ts#atomicWriteJson` but for verbatim markdown text. */
async function atomicWriteText(filePath: string, text: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `${basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Renders and atomically writes `spec` to
 * `<projectDir>/.opencode/agent/<agentId>.md` (creating the directory if
 * needed). Rejects a pre-existing file with the same agentId unless
 * `overwrite` is true.
 */
export async function generateSpecialist(
  opts: GenerateSpecialistOptions
): Promise<GenerateSpecialistResult> {
  const { projectDir, spec, denyFloor, overwrite = false } = opts;
  assertValidAgentId(spec.agentId);
  const filePath = agentPath(projectDir, spec.agentId);
  assertContained(projectDir, filePath);

  if (!overwrite && (await pathExists(filePath))) {
    throw new Error(
      `Specialist "${spec.agentId}" already exists at ${filePath} (pass overwrite: true to replace it)`
    );
  }

  const content = renderAgentFile(spec, denyFloor);
  await atomicWriteText(filePath, content);

  return { agentId: spec.agentId, path: filePath };
}

/**
 * Deletes the specialist's agent file -- but only if it carries this
 * module's `generatedBy` marker (see `GENERATED_BY`), so a hand-authored
 * OpenCode agent file that happens to share an agentId is never deleted.
 * Idempotent: `removed: false` if the file was already absent. If the file
 * exists but wasn't generated by this module, returns `removed: false` with
 * a `reason` and leaves it untouched.
 */
export async function retireSpecialist(
  opts: RetireSpecialistOptions
): Promise<RetireSpecialistResult> {
  const { projectDir, agentId } = opts;
  assertValidAgentId(agentId);
  const filePath = agentPath(projectDir, agentId);
  assertContained(projectDir, filePath);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: false };
    throw err;
  }

  if (!isGeneratedByUs(raw)) {
    return { removed: false, reason: "not generated by cohort" };
  }

  try {
    await rm(filePath);
    return { removed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: false };
    throw err;
  }
}

/** Parses a `---`-fenced YAML frontmatter block into an object, best-effort (undefined on any parse failure). */
function parseFrontmatter(raw: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return undefined;
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not valid YAML frontmatter -- fall through to undefined, per
    // "ignore non-generated files gracefully / parse best-effort".
  }
  return undefined;
}

/** Extracts `{role}` from frontmatter, best-effort. */
function parseRole(raw: string): string | undefined {
  const role = parseFrontmatter(raw)?.role;
  return typeof role === "string" ? role : undefined;
}

/** True if `raw`'s frontmatter carries this module's `generatedBy` marker (see `GENERATED_BY`). */
function isGeneratedByUs(raw: string): boolean {
  return parseFrontmatter(raw)?.generatedBy === GENERATED_BY;
}

/**
 * Scans `<projectDir>/.opencode/agent/*.md` and reports each file's id
 * (filename stem), best-effort `role` (from frontmatter, if present and
 * parseable), and whether it carries this module's `generatedBy` marker
 * (`generatedByUs` -- see `GENERATED_BY`, checked by `retireSpecialist`
 * before deleting). Files that aren't generated by this module -- or that
 * fail to parse -- are still listed, just with `role` left undefined and
 * `generatedByUs: false`. Returns `[]` if the directory doesn't exist yet.
 */
export async function listSpecialists(projectDir: string): Promise<ListedSpecialist[]> {
  const dir = agentDir(projectDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: ListedSpecialist[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    const agentId = entry.name.slice(0, -3);

    let role: string | undefined;
    let generatedByUs = false;
    try {
      const raw = await readFile(filePath, "utf8");
      role = parseRole(raw);
      generatedByUs = isGeneratedByUs(raw);
    } catch {
      // Unreadable file (e.g. removed between readdir and readFile) --
      // still report it, just without a role.
    }

    results.push({ agentId, role, path: filePath, generatedByUs });
  }

  return results.sort((a, b) => a.agentId.localeCompare(b.agentId));
}
