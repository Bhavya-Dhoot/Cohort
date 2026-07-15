/**
 * Hand-rolled `text/event-stream` reader for `GET /event` (no `EventSource`
 * global in Node). Per docs-notes.md, OpenCode frames are plain
 * `data: {...json...}\n\n` with no `event:`/`id:` lines observed, so this
 * only implements the subset of the SSE spec that matters: split on blank
 * lines, join `data:` lines, `JSON.parse`.
 */

import { OpencodeTransportError } from "./types.js";
import type { FetchFn } from "./http.js";

/**
 * Subscribes until `signal` aborts or the connection ends on its own.
 * A caller-initiated abort (`signal.aborted`) is treated as a normal
 * shutdown, not an error — resolves rather than throws. Any other drop
 * (network reset, non-2xx, missing body) throws `OpencodeTransportError`;
 * callers that treat this stream as best-effort should catch it.
 */
export async function subscribeEvents(
  fetchFn: FetchFn,
  baseUrl: string,
  directory: string | undefined,
  onRaw: (payload: unknown) => void,
  signal: AbortSignal
): Promise<void> {
  const url = new URL(`${baseUrl}/event`);
  if (directory) url.searchParams.set("directory", directory);

  let res: Response;
  try {
    res = await fetchFn(url.toString(), { signal });
  } catch (err) {
    if (signal.aborted) return;
    throw new OpencodeTransportError(
      `opencode event stream request failed: ${(err as Error).message}`,
      undefined,
      err
    );
  }

  if (!res.ok || !res.body) {
    throw new OpencodeTransportError(`opencode event stream HTTP ${res.status}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let frameEnd: number;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        emitFrame(frame, onRaw);
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    throw new OpencodeTransportError(`opencode event stream dropped: ${(err as Error).message}`, undefined, err);
  } finally {
    reader.releaseLock();
  }
}

function emitFrame(frame: string, onRaw: (payload: unknown) => void): void {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return;

  try {
    onRaw(JSON.parse(dataLines.join("\n")));
  } catch {
    // Malformed frame — skip it rather than take down the subscriber.
  }
}
