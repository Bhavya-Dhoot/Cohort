import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/memory/index.js";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `agentic-os-memory-test-${randomBytes(6).toString("hex")}`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readSection/writeSection roundtrip", () => {
  it("round-trips a markdown snapshot section verbatim", async () => {
    const store = openMemoryStore(dir);
    const content = "# Mission\n\nBuild the thing.\n";
    await store.writeSection("mission", content);
    await expect(store.readSection("mission")).resolves.toBe(content);
  });

  it("round-trips a JSON snapshot section (by parsed value)", async () => {
    const store = openMemoryStore(dir);
    const data = { contracts: [{ id: "c1", owner: "team-a" }] };
    await store.writeSection("contracts", JSON.stringify(data));
    const raw = await store.readSection("contracts");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(data);
  });

  it("rejects non-JSON content written to a JSON snapshot section", async () => {
    const store = openMemoryStore(dir);
    await expect(store.writeSection("contracts", "not json")).rejects.toThrow();
  });

  it("returns undefined for a section that was never written", async () => {
    const store = openMemoryStore(dir);
    await expect(store.readSection("architecture")).resolves.toBeUndefined();
  });
});

describe("appendEntry", () => {
  it("stamps ts and appends one JSON line per call", async () => {
    const store = openMemoryStore(dir);
    await store.appendEntry("decision-log", { decision: "use vitest" });
    await store.appendEntry("decision-log", { decision: "use zod" });

    const raw = await store.readSection("decision-log");
    const lines = raw!.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]!.decision).toBe("use vitest");
    expect(lines[1]!.decision).toBe("use zod");
    for (const line of lines) {
      expect(typeof line.ts).toBe("number");
    }
  });

  it("rejects writeSection on an append-only section", async () => {
    const store = openMemoryStore(dir);
    await expect(store.writeSection("decision-log", "text")).rejects.toThrow();
  });

  it("rejects appendEntry on a snapshot section", async () => {
    const store = openMemoryStore(dir);
    await expect(store.appendEntry("mission", { x: 1 })).rejects.toThrow();
  });

  it("serializes concurrent Promise.all appends without interleaving, preserving call order", async () => {
    const store = openMemoryStore(dir);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendEntry("known-bugs", { i }))
    );

    const raw = await store.readSection("known-bugs");
    const lines = raw!.trim().split("\n");
    expect(lines).toHaveLength(20);

    const parsed = lines.map((l) => JSON.parse(l) as { i: number; ts: number });
    expect(parsed.map((e) => e.i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    for (const entry of parsed) {
      expect(typeof entry.ts).toBe("number");
    }
  });
});

describe("section name validation", () => {
  it("rejects reads/writes/appends against an unregistered section name", async () => {
    const store = openMemoryStore(dir);
    await expect(store.readSection("nonexistent-section")).rejects.toThrow();
    await expect(store.writeSection("nonexistent-section", "x")).rejects.toThrow();
    await expect(store.appendEntry("nonexistent-section", { a: 1 })).rejects.toThrow();
  });

  it("rejects an invalid custom section name at construction time", () => {
    expect(() => openMemoryStore(dir, { sections: ["Not_Valid!"] })).toThrow();
    expect(() => openMemoryStore(dir, { sections: ["-leading-hyphen"] })).toThrow();
  });
});

describe("custom sections via opts.sections", () => {
  it("extends the allow-list and supports the normal read/write flow", async () => {
    const store = openMemoryStore(dir, { sections: ["risks"] });

    expect(store.listSections().find((s) => s.name === "risks")).toEqual({
      name: "risks",
      kind: "snapshot-md",
      exists: false
    });

    await store.writeSection("risks", "# Risks\n\nNone yet.\n");
    await expect(store.readSection("risks")).resolves.toBe("# Risks\n\nNone yet.\n");
    expect(store.listSections().find((s) => s.name === "risks")?.exists).toBe(true);
  });
});

describe("listSections", () => {
  it("lists the default sections with exists reflecting disk state", async () => {
    const store = openMemoryStore(dir);
    const before = store.listSections();

    const names = before.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "architecture",
        "contracts",
        "decision-log",
        "future-work",
        "known-bugs",
        "mission",
        "progress",
        "standards",
        "task-graph"
      ].sort()
    );
    expect(before.every((s) => s.exists === false)).toBe(true);

    await store.writeSection("mission", "# Mission\n");
    const after = store.listSections();
    expect(after.find((s) => s.name === "mission")).toEqual({
      name: "mission",
      kind: "snapshot-md",
      exists: true
    });
    expect(after.find((s) => s.name === "contracts")).toEqual({
      name: "contracts",
      kind: "snapshot-json",
      exists: false
    });
    expect(after.find((s) => s.name === "decision-log")).toEqual({
      name: "decision-log",
      kind: "append",
      exists: false
    });
  });
});

describe("buildContextBundle", () => {
  it("includes every requested section whole, in fixed priority order, when it all fits", async () => {
    const store = openMemoryStore(dir);
    await store.writeSection("mission", "Mission text.");
    await store.writeSection("architecture", "Architecture text.");
    await store.writeSection("contracts", JSON.stringify({ v: 1 }));

    // Requested out of priority order on purpose.
    const bundle = await store.buildContextBundle({
      sections: ["contracts", "mission", "architecture"],
      maxTokens: 1000
    });

    expect(bundle.truncated).toBe(false);
    expect(bundle.omitted).toEqual([]);
    expect(bundle.included).toEqual(["mission", "architecture", "contracts"]);
    expect(bundle.text.indexOf("## mission")).toBeLessThan(bundle.text.indexOf("## architecture"));
    expect(bundle.text.indexOf("## architecture")).toBeLessThan(bundle.text.indexOf("## contracts"));
    expect(bundle.tokensEstimate).toBe(Math.ceil(bundle.text.length / 4));
    expect(bundle.tokensEstimate).toBeLessThanOrEqual(1000);
  });

  it("omits low-priority sections entirely once the cap is exhausted by higher-priority ones", async () => {
    const store = openMemoryStore(dir);
    const missionContent = "Mission text.";
    const architectureContent = "Architecture text.";
    const futureWorkContent = "x".repeat(200);

    await store.writeSection("mission", missionContent);
    await store.writeSection("architecture", architectureContent);
    await store.writeSection("future-work", futureWorkContent);

    // Size the cap to exactly (or barely over) what mission + architecture
    // need, leaving too little room for future-work to fit -- whole or
    // truncated.
    const missionBlock = `## mission\n${missionContent}`;
    const architectureBlock = `## architecture\n${architectureContent}`;
    const usedChars = missionBlock.length + "\n\n".length + architectureBlock.length;
    const maxTokens = Math.ceil(usedChars / 4);

    const bundle = await store.buildContextBundle({
      sections: ["future-work", "architecture", "mission"],
      maxTokens
    });

    expect(bundle.included).toEqual(["mission", "architecture"]);
    expect(bundle.omitted).toEqual(["future-work"]);
    expect(bundle.truncated).toBe(true);
    expect(bundle.tokensEstimate).toBeLessThanOrEqual(maxTokens);
  });

  it("head-truncates a single oversized section and never exceeds the cap", async () => {
    const store = openMemoryStore(dir);
    await store.writeSection("mission", "y".repeat(500));

    const maxTokens = 20;
    const bundle = await store.buildContextBundle({ sections: ["mission"], maxTokens });

    expect(bundle.included).toEqual(["mission"]);
    expect(bundle.omitted).toEqual([]);
    expect(bundle.truncated).toBe(true);
    expect(bundle.text).toContain("…[truncated]");
    expect(bundle.tokensEstimate).toBeLessThanOrEqual(maxTokens);
    expect(bundle.tokensEstimate).toBe(Math.ceil(bundle.text.length / 4));
  });
});
