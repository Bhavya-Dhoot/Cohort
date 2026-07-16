import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonIfExists } from "../../src/lib/fs.js";
import type { SpawnFn } from "../../src/opencode-client/binary.js";
import { createOpencodeClient, normalizeUpstreamEvent } from "../../src/opencode-client/client.js";
import { OpencodeTransportError, type NormalizedEvent } from "../../src/opencode-client/types.js";
import { startFakeOpencodeServer, type FakeOpencodeServer } from "./fake-server.js";

let stateDir: string;
let fake: FakeOpencodeServer;

beforeEach(async () => {
  stateDir = join(tmpdir(), `cohort-opencode-client-test-${randomBytes(6).toString("hex")}`);
  await mkdir(stateDir, { recursive: true });
  fake = await startFakeOpencodeServer();
});

afterEach(async () => {
  await fake.close();
  await rm(stateDir, { recursive: true, force: true });
});

/** A `ChildProcess`-shaped stand-in: emits `spawn` (or `error`) on next tick. */
function fakeSpawnFn(pid: number, opts?: { failWith?: Error }): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as unknown as ChildProcess;
    Object.assign(emitter, { pid, unref: () => {} });
    setImmediate(() => {
      if (opts?.failWith) emitter.emit("error", opts.failWith);
      else emitter.emit("spawn");
    });
    return emitter;
  };
}

describe("ping", () => {
  it("resolves true for a live server", async () => {
    const client = createOpencodeClient();
    await expect(client.ping(fake.baseUrl)).resolves.toBe(true);
  });

  it("resolves false for an unreachable server", async () => {
    const client = createOpencodeClient();
    await expect(client.ping("http://127.0.0.1:1")).resolves.toBe(false);
  });
});

describe("ensureServer", () => {
  it("spawns detached and persists server.json when none exists", async () => {
    const client = createOpencodeClient({ spawnFn: fakeSpawnFn(4242), processAlive: () => true });

    const handle = await client.ensureServer({ stateDir, port: fake.port, binaryPath: "fake-opencode" });

    expect(handle).toEqual({ baseUrl: fake.baseUrl, pid: 4242, spawned: true });

    const persisted = await readJsonIfExists<{ pid: number; port: number; baseUrl: string }>(
      join(stateDir, "server.json")
    );
    expect(persisted?.pid).toBe(4242);
    expect(persisted?.port).toBe(fake.port);
    expect(persisted?.baseUrl).toBe(fake.baseUrl);
  });

  it("attaches without spawning when server.json's pid is alive and pingable", async () => {
    await writeFile(
      join(stateDir, "server.json"),
      JSON.stringify({ pid: 9999, port: fake.port, baseUrl: fake.baseUrl, startedAt: Date.now() }),
      "utf8"
    );
    let spawnCalled = false;
    const spawnFn: SpawnFn = (...args) => {
      spawnCalled = true;
      return fakeSpawnFn(1)(...args);
    };

    const client = createOpencodeClient({ spawnFn, processAlive: () => true });
    const handle = await client.ensureServer({ stateDir });

    expect(handle).toEqual({ baseUrl: fake.baseUrl, pid: 9999, spawned: false });
    expect(spawnCalled).toBe(false);
  });

  it("respawns when the recorded pid is dead, even though it can't be pinged either", async () => {
    await writeFile(
      join(stateDir, "server.json"),
      JSON.stringify({ pid: 12345, port: 1, baseUrl: "http://127.0.0.1:1", startedAt: Date.now() }),
      "utf8"
    );

    const client = createOpencodeClient({ spawnFn: fakeSpawnFn(7777), processAlive: () => false });
    const handle = await client.ensureServer({ stateDir, port: fake.port, binaryPath: "fake-opencode" });

    expect(handle).toEqual({ baseUrl: fake.baseUrl, pid: 7777, spawned: true });
  });

  it("respawns when the recorded pid is alive but stops responding", async () => {
    await writeFile(
      join(stateDir, "server.json"),
      JSON.stringify({ pid: 1, port: 1, baseUrl: "http://127.0.0.1:1", startedAt: Date.now() }),
      "utf8"
    );

    const client = createOpencodeClient({ spawnFn: fakeSpawnFn(5555), processAlive: () => true });
    const handle = await client.ensureServer({ stateDir, port: fake.port, binaryPath: "fake-opencode" });

    expect(handle).toEqual({ baseUrl: fake.baseUrl, pid: 5555, spawned: true });
  });

  it("wraps a spawn-time process error in OpencodeTransportError", async () => {
    const client = createOpencodeClient({
      spawnFn: fakeSpawnFn(0, { failWith: new Error("ENOENT: no such binary") }),
      processAlive: () => true
    });

    await expect(
      client.ensureServer({ stateDir, port: fake.port, binaryPath: "does-not-exist" })
    ).rejects.toThrow(OpencodeTransportError);
  });

  it("converges two concurrent ensureServer calls on the same stateDir onto exactly one live server", async () => {
    let spawnCount = 0;
    const spawnFn: SpawnFn = (...args) => {
      spawnCount++;
      return fakeSpawnFn(4242)(...args);
    };
    const client = createOpencodeClient({ spawnFn, processAlive: () => true });

    const [a, b] = await Promise.all([
      client.ensureServer({ stateDir, port: fake.port, binaryPath: "fake-opencode" }),
      client.ensureServer({ stateDir, port: fake.port, binaryPath: "fake-opencode" })
    ]);

    // The lock around the check-spawn-persist section means the second
    // caller waits for the first to finish and persist server.json, then
    // attaches to it instead of racing its own `opencode serve` -- so
    // exactly one process is ever spawned, and there is no "loser" process
    // that needs to be found and killed afterwards.
    expect(spawnCount).toBe(1);
    expect(a.baseUrl).toBe(fake.baseUrl);
    expect(b.baseUrl).toBe(fake.baseUrl);
    expect(a.pid).toBe(4242);
    expect(b.pid).toBe(4242);
    // Exactly one of the two calls should report having done the spawning.
    expect([a.spawned, b.spawned].filter(Boolean)).toHaveLength(1);
  });

  it("reclaims a stale lock left behind by a crashed holder instead of waiting on it forever", async () => {
    const lockPath = join(stateDir, "server.lock");
    await writeFile(lockPath, "99999999", "utf8");
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    const client = createOpencodeClient({ spawnFn: fakeSpawnFn(8181), processAlive: () => true });
    const handle = await client.ensureServer({ stateDir, port: fake.port, binaryPath: "fake-opencode" });

    expect(handle).toEqual({ baseUrl: fake.baseUrl, pid: 8181, spawned: true });
  });
});

describe("createSession", () => {
  it("posts to /session with the directory and returns SessionInfo", async () => {
    const client = createOpencodeClient();

    const info = await client.createSession(fake.baseUrl, {
      directory: "C:\\work\\proj",
      title: "hello",
      agent: "build"
    });

    expect(info.id).toMatch(/^ses_test/);
    expect(info.directory).toBe("C:\\work\\proj");
    expect(info.title).toBe("hello");
  });
});

describe("getSessionStatus", () => {
  it("derives idle from an absent map entry, busy from busy/retry", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });

    expect((await client.getSessionStatus(fake.baseUrl, info.id)).state).toBe("idle");

    fake.statusMap.set(info.id, { type: "busy" });
    expect((await client.getSessionStatus(fake.baseUrl, info.id)).state).toBe("busy");

    fake.statusMap.set(info.id, { type: "retry", attempt: 1, message: "retrying", next: 1000 });
    expect((await client.getSessionStatus(fake.baseUrl, info.id)).state).toBe("busy");

    fake.statusMap.set(info.id, { type: "idle" });
    expect((await client.getSessionStatus(fake.baseUrl, info.id)).state).toBe("idle");
  });
});

describe("abort", () => {
  it("resolves without throwing against a real session", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });

    await expect(client.abort(fake.baseUrl, info.id)).resolves.toBeUndefined();
  });
});

describe("prompt", () => {
  it("resolves 'completed' and forwards normalized events via onEvent", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });

    fake.eventsToEmit = [
      {
        id: "e1",
        type: "message.part.updated",
        properties: { sessionID: info.id, part: { type: "tool", tool: "bash", state: { status: "running" } }, time: 1 }
      },
      {
        id: "e2",
        type: "message.part.updated",
        properties: { sessionID: info.id, part: { type: "text", text: "hello   world" } }
      },
      { id: "e3", type: "session.idle", properties: { sessionID: info.id } },
      // Not scoped to this session — must be dropped, not counted.
      { id: "e4", type: "session.idle", properties: { sessionID: "ses_other" } }
    ];
    fake.messageBehavior = { kind: "completed" };

    const received: NormalizedEvent[] = [];
    const result = await client.prompt(fake.baseUrl, info.id, "do the thing", {
      onEvent: (evt) => received.push(evt)
    });

    expect(result.outcome).toBe("completed");
    expect(result.eventCount).toBe(3);
    expect(received.map((e) => e.kind)).toEqual(["tool", "message", "idle"]);
    expect(received[1]?.summary).toBe("hello world");
  });

  it("maps a server-reported turn error to outcome:'error'", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });
    fake.messageBehavior = { kind: "error", name: "APIError", message: "rate limited" };

    const result = await client.prompt(fake.baseUrl, info.id, "do the thing");

    expect(result.outcome).toBe("error");
    expect(result.error).toContain("APIError");
    expect(result.error).toContain("rate limited");
  });

  it("maps a MessageAbortedError turn error to outcome:'aborted'", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });
    fake.messageBehavior = { kind: "error", name: "MessageAbortedError", message: "aborted by user" };

    const result = await client.prompt(fake.baseUrl, info.id, "do the thing");

    expect(result.outcome).toBe("aborted");
  });

  it("resolves 'aborted' when the caller's signal aborts mid-flight", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });
    // No eventsToEmit configured, so the fake server responds immediately;
    // abort before that response is awaited by racing a pre-aborted signal
    // against a behavior that would otherwise complete normally.
    const controller = new AbortController();
    controller.abort();

    const result = await client.prompt(fake.baseUrl, info.id, "do the thing", { signal: controller.signal });

    expect(result.outcome).toBe("aborted");
  });

  it("throws OpencodeTransportError when the stream drops with zero observed events", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });
    fake.messageBehavior = { kind: "dropped" };

    await expect(client.prompt(fake.baseUrl, info.id, "do the thing")).rejects.toThrow(OpencodeTransportError);
    await expect(client.prompt(fake.baseUrl, info.id, "do the thing")).rejects.toThrow(/0 progress event/);
  });
});

describe("getUsage", () => {
  it("maps cost/tokens/summary from GET /session/:id", async () => {
    const client = createOpencodeClient();
    const info = await client.createSession(fake.baseUrl, { directory: "C:\\work\\proj" });
    const session = fake.sessions.get(info.id);
    if (!session) throw new Error("test setup: session missing from fake server");
    session.cost = 1.23;
    session.tokens = { input: 100, output: 200, reasoning: 10, cache: { read: 5, write: 2 } };
    session.summary = { files: 3, additions: 20, deletions: 4 };

    const usage = await client.getUsage(fake.baseUrl, info.id);

    expect(usage.costUsd).toBe(1.23);
    expect(usage.tokens).toEqual({ input: 100, output: 200, reasoning: 10, cacheRead: 5, cacheWrite: 2 });
    expect(usage.summary).toEqual({ files: 3, additions: 20, deletions: 4 });
  });

  it("throws OpencodeTransportError for an unknown session with no export fallback available", async () => {
    const client = createOpencodeClient();
    await expect(client.getUsage(fake.baseUrl, "ses_does_not_exist")).rejects.toThrow(OpencodeTransportError);
    // Longer timeout: getUsage's fallback shells out to a real `opencode export`
    // subprocess, whose spawn latency spikes under full-suite parallel load.
  }, 30_000);
});

describe("normalizeUpstreamEvent", () => {
  const sid = "ses_abc";

  it("drops events not scoped to the requested session", () => {
    expect(normalizeUpstreamEvent({ id: "e", type: "session.idle", properties: { sessionID: "other" } }, sid)).toBeUndefined();
    expect(normalizeUpstreamEvent({ id: "e", type: "server.connected", properties: {} }, sid)).toBeUndefined();
  });

  it("maps session.error to kind 'error'", () => {
    const evt = normalizeUpstreamEvent(
      { id: "e", type: "session.error", properties: { sessionID: sid, error: { name: "APIError", data: { message: "boom" } } } },
      sid
    );
    expect(evt?.kind).toBe("error");
    expect(evt?.summary).toContain("boom");
  });

  it("maps an unrecognized event type to kind 'other' with a one-line summary", () => {
    const evt = normalizeUpstreamEvent({ id: "e", type: "session.diff", properties: { sessionID: sid } }, sid);
    expect(evt?.kind).toBe("other");
    expect(evt?.summary).toBe("session.diff");
  });
});
