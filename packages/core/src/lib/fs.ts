import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writes JSON to `filePath` atomically: serializes to a uniquely-named
 * `.tmp` file in the same directory, then renames it over the target.
 * `fs.rename` replaces an existing destination file on Windows and POSIX
 * alike, so readers never observe a partially-written file.
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(
    dir,
    `${basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`
  );
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Reads and parses `filePath` as JSON, returning `undefined` if the file
 * does not exist. Any other read/parse error propagates.
 */
export async function readJsonIfExists<T>(
  filePath: string
): Promise<T | undefined> {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}
