import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJson, readJsonIfExists } from "../../src/lib/fs.js";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `cohort-fs-test-${randomBytes(6).toString("hex")}`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteJson", () => {
  it("creates the parent directory and writes valid JSON", async () => {
    const filePath = join(dir, "nested", "data.json");
    await atomicWriteJson(filePath, { hello: "world" });

    const contents = JSON.parse(await readFile(filePath, "utf8"));
    expect(contents).toEqual({ hello: "world" });
  });

  it("overwrites an existing file with new content", async () => {
    const filePath = join(dir, "data.json");
    await atomicWriteJson(filePath, { version: 1 });
    await atomicWriteJson(filePath, { version: 2 });

    const contents = JSON.parse(await readFile(filePath, "utf8"));
    expect(contents).toEqual({ version: 2 });
  });

  it("does not leave a .tmp file behind after writing", async () => {
    const filePath = join(dir, "data.json");
    await atomicWriteJson(filePath, { ok: true });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["data.json"]);
  });
});

describe("readJsonIfExists", () => {
  it("returns undefined when the file does not exist", async () => {
    const filePath = join(dir, "missing.json");
    await expect(readJsonIfExists(filePath)).resolves.toBeUndefined();
  });

  it("returns the parsed JSON when the file exists", async () => {
    const filePath = join(dir, "data.json");
    await atomicWriteJson(filePath, { count: 42 });

    await expect(readJsonIfExists<{ count: number }>(filePath)).resolves.toEqual({
      count: 42
    });
  });

  it("reflects the latest content after an overwrite", async () => {
    const filePath = join(dir, "data.json");
    await atomicWriteJson(filePath, { count: 1 });
    await atomicWriteJson(filePath, { count: 2 });

    await expect(readJsonIfExists<{ count: number }>(filePath)).resolves.toEqual({
      count: 2
    });
  });
});
