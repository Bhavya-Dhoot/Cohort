/**
 * Small `fetch` wrapper shared by every OpenCode HTTP call: applies a
 * timeout (unless the caller opts out), and normalizes every failure mode
 * — network error, non-2xx status, unparsable body — into
 * `OpencodeTransportError` so callers never have to distinguish "fetch
 * threw" from "fetch resolved but the server said no."
 */

import { OpencodeTransportError } from "./types.js";

export type FetchFn = typeof fetch;

function combinedSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (callerSignal) signals.push(callerSignal);
  if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * `timeoutMs === undefined` means "no base timeout" — used for `prompt()`,
 * which is caller-controlled via `opts.signal` per the contract.
 */
export async function fetchJson<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined
): Promise<T> {
  const signal = combinedSignal(init.signal, timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal });
  } catch (err) {
    throw new OpencodeTransportError(
      `opencode request failed: ${describeUrl(url)}: ${(err as Error).message}`,
      undefined,
      err
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OpencodeTransportError(
      `opencode HTTP ${res.status} for ${describeUrl(url)}${body ? `: ${body.slice(0, 500)}` : ""}`,
      res.status
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new OpencodeTransportError(
      `opencode response was not valid JSON: ${describeUrl(url)}`,
      res.status,
      err
    );
  }
}
