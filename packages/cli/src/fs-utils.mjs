import { access } from "node:fs/promises";

/** True if `path` exists (file or directory), false otherwise — never throws. */
export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
