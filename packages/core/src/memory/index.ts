import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWriteJson } from "../lib/fs.js";

/**
 * Shared project memory: a small set of named sections persisted as files
 * under a memory directory (conventionally `<project>/.agentic-os/memory/`
 * -- `dir` is used as-is, this module does not append that suffix, matching
 * the rest of core where callers pass exact paths, e.g. `openEventLog`).
 *
 * Two section kinds:
 *  - "snapshot-md" / "snapshot-json": overwrite-in-place documents. JSON
 *    sections go through `atomicWriteJson` (lib/fs.ts) so they're
 *    re-serialized/pretty-printed on write; markdown sections go through a
 *    local `atomicWriteText` that mirrors the same temp-file + rename
 *    pattern for verbatim text, since `atomicWriteJson` would wrap plain
 *    markdown in a JSON string literal.
 *  - "append": JSONL logs, one stamped entry per line. Appends are
 *    serialized through a per-section promise chain -- the same technique
 *    `openEventLog` (events/index.ts) uses -- so concurrent `appendEntry`
 *    calls never interleave their writes.
 */

export type SectionKind = "snapshot-md" | "snapshot-json" | "append";

export interface SectionInfo {
  name: string;
  kind: SectionKind;
  exists: boolean;
}

export interface OpenMemoryStoreOptions {
  /**
   * Extends the default section allow-list with additional section names --
   * the extension-point hook for memory sections. Custom sections default
   * to kind "snapshot-md" (free-form text); unknown names outside the
   * default set plus this list are rejected with a clear error.
   */
  sections?: string[];
}

export interface ContextBundleOptions {
  sections: string[];
  maxTokens: number;
}

export interface ContextBundle {
  text: string;
  tokensEstimate: number;
  truncated: boolean;
  included: string[];
  omitted: string[];
}

export interface MemoryStore {
  readSection(name: string): Promise<string | undefined>;
  writeSection(name: string, content: string): Promise<void>;
  appendEntry(name: string, entry: Record<string, unknown>): Promise<void>;
  buildContextBundle(opts: ContextBundleOptions): Promise<ContextBundle>;
  listSections(): SectionInfo[];
}

const SECTION_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

const DEFAULT_SNAPSHOT_MD = ["mission", "architecture", "standards", "progress", "future-work"];
const DEFAULT_SNAPSHOT_JSON = ["contracts", "task-graph"];
const DEFAULT_APPEND = ["decision-log", "known-bugs"];

/**
 * Fixed cut order when `buildContextBundle`'s token cap forces cuts.
 * Sections not listed here (custom sections) sort after all of these, in
 * the order they were requested.
 */
const PRIORITY_ORDER = [
  "mission",
  "architecture",
  "contracts",
  "standards",
  "task-graph",
  "progress",
  "decision-log",
  "known-bugs",
  "future-work"
];

const TRUNCATION_MARKER = "\n…[truncated]";
const BLOCK_SEPARATOR = "\n\n";

function extensionFor(kind: SectionKind): string {
  switch (kind) {
    case "snapshot-md":
      return "md";
    case "snapshot-json":
      return "json";
    case "append":
      return "jsonl";
  }
}

async function readRaw(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * Writes raw text to `filePath` atomically via a same-dir temp file +
 * rename. Mirrors `atomicWriteJson` in lib/fs.ts, but for verbatim text
 * (markdown, or already-serialized JSON) that must round-trip byte-for-byte
 * rather than be re-encoded by `JSON.stringify`.
 */
async function atomicWriteText(filePath: string, text: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `${basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, filePath);
}

function priorityIndex(name: string): number {
  const idx = PRIORITY_ORDER.indexOf(name);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

/**
 * Opens a memory store bound to `dir`. Synchronous (no I/O happens until a
 * method is called) so it's cheap to construct per-call the way
 * `openEventLog` is.
 */
export function openMemoryStore(dir: string, opts?: OpenMemoryStoreOptions): MemoryStore {
  const kinds = new Map<string, SectionKind>();
  for (const name of DEFAULT_SNAPSHOT_MD) kinds.set(name, "snapshot-md");
  for (const name of DEFAULT_SNAPSHOT_JSON) kinds.set(name, "snapshot-json");
  for (const name of DEFAULT_APPEND) kinds.set(name, "append");

  for (const name of opts?.sections ?? []) {
    if (!SECTION_NAME_RE.test(name)) {
      throw new Error(
        `Invalid memory section name "${name}": must match ${SECTION_NAME_RE}`
      );
    }
    if (!kinds.has(name)) {
      kinds.set(name, "snapshot-md");
    }
  }

  // Per-section promise chains so concurrent appendEntry calls on the same
  // section serialize their writes (different sections append independently).
  const appendChains = new Map<string, Promise<unknown>>();

  function resolve(name: string): { kind: SectionKind; path: string } {
    const kind = kinds.get(name);
    if (!kind) {
      const known = [...kinds.keys()].sort().join(", ");
      throw new Error(`Unknown memory section "${name}". Configured sections: ${known}`);
    }
    return { kind, path: join(dir, `${name}.${extensionFor(kind)}`) };
  }

  async function readSection(name: string): Promise<string | undefined> {
    const { path } = resolve(name);
    return readRaw(path);
  }

  async function writeSection(name: string, content: string): Promise<void> {
    const { kind, path } = resolve(name);
    if (kind === "append") {
      throw new Error(
        `Section "${name}" is append-only; use appendEntry, not writeSection.`
      );
    }
    if (kind === "snapshot-json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        throw new Error(
          `Section "${name}" content is not valid JSON: ${(err as Error).message}`
        );
      }
      await atomicWriteJson(path, parsed);
      return;
    }
    await atomicWriteText(path, content);
  }

  async function appendEntry(name: string, entry: Record<string, unknown>): Promise<void> {
    const { kind, path } = resolve(name);
    if (kind !== "append") {
      throw new Error(
        `Section "${name}" is not append-only; use writeSection, not appendEntry.`
      );
    }
    const prior = appendChains.get(name) ?? Promise.resolve();
    const task = prior.then(async () => {
      const stamped = { ...entry, ts: Date.now() };
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(stamped)}\n`, "utf8");
    });
    appendChains.set(name, task.catch(() => undefined));
    await task;
  }

  /**
   * Concatenates `opts.sections` as labeled markdown blocks (`## <name>\n
   * <content>`) in the fixed priority order, never exceeding `maxTokens`
   * (estimated as `ceil(chars/4)`). Sections are included whole, greedily,
   * highest priority first; the first section that doesn't fit whole gets a
   * head-truncated block sized to exactly fill the remaining budget (if
   * there's enough room left for a header + the truncation marker), and
   * every section after that is omitted since no budget remains.
   */
  async function buildContextBundle(bundleOpts: ContextBundleOptions): Promise<ContextBundle> {
    const { sections, maxTokens } = bundleOpts;
    const ordered = [...sections].sort((a, b) => priorityIndex(a) - priorityIndex(b));

    const maxChars = maxTokens * 4;
    const parts: string[] = [];
    const included: string[] = [];
    const omitted: string[] = [];
    let usedChars = 0;
    let truncated = false;

    for (const name of ordered) {
      const content = await readSection(name); // also validates the name
      if (content === undefined) {
        continue; // nothing written for this section -- nothing to bundle
      }

      const header = `## ${name}\n`;
      const block = `${header}${content}`;
      const prefix = parts.length > 0 ? BLOCK_SEPARATOR : "";
      const needed = prefix.length + block.length;

      if (usedChars + needed <= maxChars) {
        parts.push(block);
        usedChars += needed;
        included.push(name);
        continue;
      }

      const available = maxChars - usedChars - prefix.length;
      const overhead = header.length + TRUNCATION_MARKER.length;
      if (available > overhead) {
        const headContent = content.slice(0, available - overhead);
        const truncatedBlock = `${header}${headContent}${TRUNCATION_MARKER}`;
        parts.push(truncatedBlock);
        usedChars += prefix.length + truncatedBlock.length;
        included.push(name);
      } else {
        omitted.push(name);
      }
      truncated = true;
    }

    const text = parts.join(BLOCK_SEPARATOR);
    return {
      text,
      tokensEstimate: Math.ceil(text.length / 4),
      truncated,
      included,
      omitted
    };
  }

  function listSections(): SectionInfo[] {
    return [...kinds.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, kind]) => ({
        name,
        kind,
        exists: existsSync(join(dir, `${name}.${extensionFor(kind)}`))
      }));
  }

  return { readSection, writeSection, appendEntry, buildContextBundle, listSections };
}
