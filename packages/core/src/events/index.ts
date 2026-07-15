import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
 * Opens an append-only JSONL event log bound to `filePath`. Concurrent
 * `append` calls within the process are serialized via an internal promise
 * chain so `seq` stays monotonic and ordered. `seq` is initialized lazily,
 * from the last valid line on disk, the first time `append` runs; if that
 * initial read finds a torn trailing line, the file is rewritten to drop it
 * before the new line is appended.
 */
export function openEventLog(filePath: string): EventLog {
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let initPromise: Promise<void> | undefined;

  async function init(): Promise<void> {
    const raw = await readRaw(filePath);
    if (raw === undefined) {
      seq = 0;
      return;
    }
    const { events, torn } = parseLines(filePath, raw);
    seq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    if (torn) {
      const healed = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      await writeFile(filePath, healed, "utf8");
    }
  }

  function ensureInit(): Promise<void> {
    if (!initPromise) {
      initPromise = init();
    }
    return initPromise;
  }

  function append(
    event: { type: string; [key: string]: unknown }
  ): Promise<StoredEvent> {
    const task = chain.then(async () => {
      await ensureInit();
      seq += 1;
      const stored: StoredEvent = { ...event, seq, ts: Date.now() };
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf8");
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
