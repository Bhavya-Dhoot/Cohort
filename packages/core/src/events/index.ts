import { randomBytes } from "node:crypto";
import { mkdir, appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * An event as stored on disk: caller-supplied fields plus a stamped
 * monotonic `seq` (1-based) and `ts` (epoch ms).
 */
export interface StoredEvent {
  seq: number;
  ts: number;
  type: string;
  [key: string]: unknown;
}

export interface EventLog {
  append(event: { type: string; [key: string]: unknown }): Promise<StoredEvent>;
  read(sinceSeq?: number): Promise<StoredEvent[]>;
}

interface ParsedLog {
  events: StoredEvent[];
  /** true if the last line was present but failed to parse (a torn write). */
  torn: boolean;
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
 * Parses JSONL content tolerantly: a trailing line that fails to parse is
 * treated as a torn/partial write and ignored. A line that fails to parse
 * anywhere before the last line is real corruption and throws.
 */
function parseLines(filePath: string, raw: string): ParsedLog {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const events: StoredEvent[] = [];
  let torn = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]!) as StoredEvent);
    } catch (err) {
      if (i === lines.length - 1) {
        torn = true;
        break;
      }
      throw new Error(
        `Corrupt event log at ${filePath}: invalid JSON on line ${i + 1}`
      );
    }
  }
  return { events, torn };
}

/**
 * Overwrites `filePath` with `content` via a same-dir temp file + rename,
 * rather than an in-place `writeFile` (which truncates the destination
 * before writing the replacement, letting a concurrent reader observe a
 * short/empty file mid-write). `rename` replaces the destination file
 * atomically on both Windows and POSIX.
 */
async function atomicRewrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  const tmpPath = join(
    dir,
    `${basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`
  );
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Opens an append-only JSONL event log bound to `filePath`. Concurrent
 * `append` calls within the process are serialized via an internal promise
 * chain so `seq` stays monotonic and ordered. `seq` is initialized lazily,
 * from the last valid line on disk, the first time `append` runs; if that
 * initial read finds a torn trailing line, the file is healed via
 * temp-file + rename before the new line is appended.
 *
 * `seq` is otherwise kept purely in memory, which would let a second
 * process appending to the same file (e.g. an orphaned MCP server sharing a
 * run's events.jsonl) silently reuse a `seq` this instance already handed
 * out. To mitigate, each append first `stat`s the file and compares its
 * size against what this instance last knew (updated cheaply after each of
 * its own appends, no re-read needed); a mismatch means someone else wrote
 * to the file, so the in-memory state is rebuilt from a fresh read before
 * continuing.
 */
export function openEventLog(filePath: string): EventLog {
  let seq = 0;
  let knownSize = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let initPromise: Promise<void> | undefined;

  async function init(): Promise<void> {
    const raw = await readRaw(filePath);
    if (raw === undefined) {
      seq = 0;
      knownSize = 0;
      return;
    }
    const { events, torn } = parseLines(filePath, raw);
    seq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    if (torn) {
      const healed = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      await atomicRewrite(filePath, healed);
      knownSize = Buffer.byteLength(healed, "utf8");
    } else {
      knownSize = Buffer.byteLength(raw, "utf8");
    }
  }

  function ensureInit(): Promise<void> {
    if (!initPromise) {
      initPromise = init();
    }
    return initPromise;
  }

  // ponytail: this closes the common case (a stale/orphaned second writer)
  // but not the full race -- two processes appending at the same instant
  // can both pass this check before either's append lands on disk, so a
  // genuine seq collision between two *simultaneous* cross-process appends
  // is still possible. Closing that fully needs a real file lock. Accepted
  // as an M1 ceiling: worker event logs are designed to have a single
  // supervisor process per file.
  async function detectExternalWrite(): Promise<void> {
    let currentSize: number;
    try {
      currentSize = (await stat(filePath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        currentSize = 0;
      } else {
        throw err;
      }
    }
    if (currentSize !== knownSize) {
      await init();
    }
  }

  function append(
    event: { type: string; [key: string]: unknown }
  ): Promise<StoredEvent> {
    const task = chain.then(async () => {
      await ensureInit();
      await detectExternalWrite();
      seq += 1;
      const stored: StoredEvent = { ...event, seq, ts: Date.now() };
      await mkdir(dirname(filePath), { recursive: true });
      const line = `${JSON.stringify(stored)}\n`;
      await appendFile(filePath, line, "utf8");
      knownSize += Buffer.byteLength(line, "utf8");
      return stored;
    });
    // Keep the chain alive even if this append fails, so later appends
    // still run (and still see the failure via their own `task`).
    chain = task.catch(() => undefined);
    return task;
  }

  async function read(sinceSeq?: number): Promise<StoredEvent[]> {
    const raw = await readRaw(filePath);
    if (raw === undefined) {
      return [];
    }
    const { events } = parseLines(filePath, raw);
    return sinceSeq === undefined ? events : events.filter((event) => event.seq > sinceSeq);
  }

  return { append, read };
}
