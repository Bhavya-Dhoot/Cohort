import { createHash } from "node:crypto";
import { join } from "node:path";

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Deterministic, short worktree path: `<baseDir>/<first8-of-sha256(runId)>/
 * <first8-of-sha256(workerId)>`. Hashing (rather than using the raw ids)
 * keeps the path short and filesystem-safe regardless of what characters or
 * length the ids have, which matters on Windows where the full path
 * (including everything git writes under it) must stay under MAX_PATH.
 */
export function worktreePathFor(baseDir: string, runId: string, workerId: string): string {
  return join(baseDir, shortHash(runId), shortHash(workerId));
}
