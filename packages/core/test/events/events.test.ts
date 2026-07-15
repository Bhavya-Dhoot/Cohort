import { randomBytes } from "node:crypto";
import { appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEventLog } from "../../src/events/index.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = join(tmpdir(), `agentic-os-events-test-${randomBytes(6).toString("hex")}`);
  filePath = join(dir, "events.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("append/read roundtrip", () => {
  it("stamps seq (1-based) and ts on append, and read returns them in order", async () => {
    const log = openEventLog(filePath);

    const first = await log.append({ type: "started", workerId: "w1" });
    const second = await log.append({ type: "progress", pct: 50 });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(typeof first.ts).toBe("number");
    expect(typeof second.ts).toBe("number");

    const events = await log.read();
    expect(events).toEqual([first, second]);
  });

  it("creates parent directories on first append", async () => {
    const nested = join(dir, "nested", "sub", "events.jsonl");
    const log = openEventLog(nested);
    await log.append({ type: "started" });

    const contents = await readFile(nested, "utf8");
    expect(contents.trim().length).toBeGreaterThan(0);
  });

  it("returns [] when the file does not exist", async () => {
    const log = openEventLog(filePath);
    await expect(log.read()).resolves.toEqual([]);
  });
});

describe("sinceSeq", () => {
  it("filters to events with seq strictly greater than sinceSeq", async () => {
    const log = openEventLog(filePath);
    await log.append({ type: "a" });
    await log.append({ type: "b" });
    const third = await log.append({ type: "c" });

    const events = await log.read(2);
    expect(events).toEqual([third]);
  });
});

describe("torn-write recovery", () => {
  it("ignores a trailing torn line on read, then a new EventLog heals the file on append", async () => {
    const log = openEventLog(filePath);
    await log.append({ type: "a" });
    await log.append({ type: "b" });

    // Simulate a crash mid-write: a partial, unterminated JSON line.
    await appendFile(filePath, '{"seq":99,"ty', "utf8");

    const eventsBeforeHeal = await log.read();
    expect(eventsBeforeHeal.map((e) => e.type)).toEqual(["a", "b"]);

    // A fresh EventLog opened on the same file must pick up the next seq
    // from the last *valid* line (2), not the torn fragment.
    const reopened = openEventLog(filePath);
    const healedAppend = await reopened.append({ type: "c" });
    expect(healedAppend.seq).toBe(3);

    const healedEvents = await reopened.read();
    expect(healedEvents.map((e) => e.type)).toEqual(["a", "b", "c"]);
    expect(healedEvents.map((e) => e.seq)).toEqual([1, 2, 3]);

    // The file itself must be healed: every line parses as valid JSON.
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("throws on a corrupt line in the middle of the file (not the tail)", async () => {
    const log = openEventLog(filePath);
    await log.append({ type: "a" });
    // Inject a corrupt line, then a valid line after it so it's no longer
    // the tail - this is data corruption, not a torn write.
    await appendFile(filePath, "not json at all\n", "utf8");
    await appendFile(filePath, `${JSON.stringify({ seq: 3, ts: Date.now(), type: "c" })}\n`, "utf8");

    await expect(log.read()).rejects.toThrow();
  });
});

describe("concurrent appends", () => {
  it("20 concurrent appends yield 20 distinct, ordered seqs", async () => {
    const log = openEventLog(filePath);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => log.append({ type: "e", i }))
    );

    const seqs = results.map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    const events = await log.read();
    expect(events).toHaveLength(20);
    expect(events.map((e) => e.seq)).toEqual(seqs);
  });
});
