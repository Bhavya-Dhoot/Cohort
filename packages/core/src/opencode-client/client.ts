/**
 * `OpencodeClient` implementation wrapping the real `opencode serve` HTTP
 * API. Endpoint shapes are taken from a live `GET /doc` (opencode 1.15.13);
 * see docs-notes.md for the full discovery record and every point where the
 * architecture doc's assumptions needed correcting.
 *
 * `createOpencodeClient` accepts an optional `deps` object (spawn function,
 * process-liveness check, fetch function) purely as a test seam — it is not
 * part of the `OpencodeClient` contract in types.ts, and every field has a
 * real-world default so `createOpencodeClient()` with no arguments is a
 * fully working client.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, readJsonIfExists } from "../lib/fs.js";
import {
  defaultProcessAlive,
  getFreePort,
  resolveExecutable,
  runOpencodeExport,
  spawnDetachedServer,
  type SpawnFn
} from "./binary.js";
import { fetchJson, type FetchFn } from "./http.js";
import { subscribeEvents } from "./sse.js";
import {
  OpencodeTransportError,
  type CreateSessionOptions,
  type EnsureServerOptions,
  type NormalizedEvent,
  type OpencodeClient,
  type PromptResult,
  type ServerHandle,
  type SessionInfo,
  type SessionStatus,
  type SessionUsage
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 2_000;
const SERVER_READY_TIMEOUT_MS = 15_000;
const SERVER_READY_POLL_MS = 300;

export interface OpencodeClientDeps {
  fetchFn: FetchFn;
  spawnFn: SpawnFn;
  processAlive: (pid: number) => boolean;
}

interface ServerJson {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
}

interface UpstreamSession {
  id: string;
  directory: string;
  title?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  summary?: { files?: number; additions?: number; deletions?: number };
}

interface UpstreamErrorPayload {
  name: string;
  data?: { message?: string };
}

interface UpstreamMessageResponse {
  info: { id: string; sessionID: string; role: string; error?: UpstreamErrorPayload };
  parts: unknown[];
}

type UpstreamSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

interface UpstreamEvent {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionToUsage(session: UpstreamSession): SessionUsage {
  return {
    costUsd: session.cost,
    tokens: session.tokens
      ? {
          input: session.tokens.input,
          output: session.tokens.output,
          reasoning: session.tokens.reasoning,
          cacheRead: session.tokens.cache?.read,
          cacheWrite: session.tokens.cache?.write
        }
      : undefined,
    summary: session.summary
      ? {
          files: session.summary.files,
          additions: session.summary.additions,
          deletions: session.summary.deletions
        }
      : undefined
  };
}

function describeUpstreamError(err: UpstreamErrorPayload): string {
  return `${err.name}: ${err.data?.message ?? "unknown error"}`;
}

/**
 * Maps a raw `/event` payload to a `NormalizedEvent`, or `undefined` if the
 * event isn't scoped to `sessionId` (server-wide events like
 * `server.connected` carry no `sessionID` at all and are dropped rather than
 * surfaced as `'other'`, so concurrent workers sharing one `opencode serve`
 * don't see each other's noise).
 */
export function normalizeUpstreamEvent(raw: unknown, sessionId: string): NormalizedEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const evt = raw as UpstreamEvent;
  const props = evt.properties ?? {};
  const eventSessionId = typeof props.sessionID === "string" ? props.sessionID : undefined;
  if (eventSessionId !== sessionId) return undefined;

  const ts = Date.now();

  switch (evt.type) {
    case "session.idle":
      return { ts, kind: "idle", summary: "session idle", raw };

    case "session.error": {
      const err = props.error as UpstreamErrorPayload | undefined;
      return { ts, kind: "error", summary: err ? describeUpstreamError(err) : "session error", raw };
    }

    case "message.updated": {
      const info = props.info as { role?: string; error?: UpstreamErrorPayload } | undefined;
      if (info?.error) {
        return { ts, kind: "error", summary: describeUpstreamError(info.error), raw };
      }
      return { ts, kind: "message", summary: `${info?.role ?? "message"} updated`, raw };
    }

    case "message.part.updated": {
      const part = props.part as
        | { type?: string; tool?: string; text?: string; state?: { status?: string } }
        | undefined;
      if (part?.type === "tool") {
        return {
          ts,
          kind: "tool",
          summary: `tool ${part.tool ?? "unknown"}: ${part.state?.status ?? "update"}`,
          raw
        };
      }
      if (part?.type === "text") {
        const oneLine = (part.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        return { ts, kind: "message", summary: oneLine || "text update", raw };
      }
      return { ts, kind: "other", summary: `part update: ${part?.type ?? "unknown"}`, raw };
    }

    case "session.status": {
      const status = props.status as UpstreamSessionStatus | undefined;
      if (status?.type === "idle") return { ts, kind: "idle", summary: "session idle", raw };
      return { ts, kind: "other", summary: `session status: ${status?.type ?? "unknown"}`, raw };
    }

    default:
      return { ts, kind: "other", summary: evt.type, raw };
  }
}

export function createOpencodeClient(deps: Partial<OpencodeClientDeps> = {}): OpencodeClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const spawnFn = deps.spawnFn ?? spawn;
  const processAlive = deps.processAlive ?? defaultProcessAlive;

  async function ping(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetchFn(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function ensureServer(opts: EnsureServerOptions): Promise<ServerHandle> {
    await mkdir(opts.stateDir, { recursive: true });
    const serverJsonPath = join(opts.stateDir, "server.json");

    const existing = await readJsonIfExists<ServerJson>(serverJsonPath);
    if (existing && processAlive(existing.pid) && (await ping(existing.baseUrl))) {
      return { baseUrl: existing.baseUrl, pid: existing.pid, spawned: false };
    }

    const port = opts.port ?? (await getFreePort());
    const hostname = "127.0.0.1";
    const baseUrl = `http://${hostname}:${port}`;
    const logFile = opts.logFile ?? join(opts.stateDir, "opencode-serve.log");
    const binaryPath = opts.binaryPath ?? "opencode";

    const { pid } = await spawnDetachedServer({
      binaryPath,
      port,
      hostname,
      cwd: opts.stateDir,
      env: opts.env,
      logFile,
      spawnFn
    });

    const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (await ping(baseUrl)) {
        ready = true;
        break;
      }
      await sleep(SERVER_READY_POLL_MS);
    }
    if (!ready) {
      throw new OpencodeTransportError(
        `opencode serve (pid ${pid}) did not become ready within ${SERVER_READY_TIMEOUT_MS}ms on ${baseUrl}; see ${logFile}`
      );
    }

    const serverJson: ServerJson = { pid, port, baseUrl, startedAt: Date.now() };
    await atomicWriteJson(serverJsonPath, serverJson);

    return { baseUrl, pid, spawned: true };
  }

  async function createSession(baseUrl: string, opts: CreateSessionOptions): Promise<SessionInfo> {
    const url = new URL(`${baseUrl}/session`);
    url.searchParams.set("directory", opts.directory);

    const body: Record<string, unknown> = {};
    if (opts.title) body.title = opts.title;
    if (opts.agent) body.agent = opts.agent;
    if (opts.model) {
      const slash = opts.model.indexOf("/");
      const providerID = slash === -1 ? opts.model : opts.model.slice(0, slash);
      const id = slash === -1 ? opts.model : opts.model.slice(slash + 1);
      body.model = { providerID, id };
    }

    const session = await fetchJson<UpstreamSession>(
      fetchFn,
      url.toString(),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      DEFAULT_TIMEOUT_MS
    );

    return { id: session.id, directory: session.directory, title: session.title };
  }

  /**
   * `GET /session/status` returns a map keyed by session ID, but only for
   * sessions with a "newsworthy" status — a freshly created, never-prompted
   * session is simply absent (verified live: `{}`). Absence is therefore
   * read as `idle`, not `unknown`; `busy`/`retry` both mean "actively
   * processing" and map to `busy`. See docs-notes.md.
   */
  async function getSessionStatus(baseUrl: string, sessionId: string): Promise<SessionStatus> {
    const statusMap = await fetchJson<Record<string, UpstreamSessionStatus>>(
      fetchFn,
      `${baseUrl}/session/status`,
      { method: "GET" },
      DEFAULT_TIMEOUT_MS
    );

    const entry = statusMap[sessionId];
    if (!entry || entry.type === "idle") return { id: sessionId, state: "idle" };
    if (entry.type === "busy" || entry.type === "retry") return { id: sessionId, state: "busy" };
    return { id: sessionId, state: "unknown" };
  }

  async function abort(baseUrl: string, sessionId: string): Promise<void> {
    await fetchJson<boolean>(
      fetchFn,
      `${baseUrl}/session/${sessionId}/abort`,
      { method: "POST" },
      DEFAULT_TIMEOUT_MS
    );
  }

  async function prompt(
    baseUrl: string,
    sessionId: string,
    text: string,
    opts?: { signal?: AbortSignal; onEvent?: (evt: NormalizedEvent) => void }
  ): Promise<PromptResult> {
    const signal = opts?.signal;
    const onEvent = opts?.onEvent;
    let eventCount = 0;

    // The SSE subscription is a best-effort progress side-channel; the
    // blocking POST below is the sole source of truth for the outcome.
    const sseAbort = new AbortController();
    let ssePromise: Promise<void> | undefined;
    if (onEvent) {
      const sseSignal = signal ? AbortSignal.any([signal, sseAbort.signal]) : sseAbort.signal;
      ssePromise = subscribeEvents(
        fetchFn,
        baseUrl,
        undefined,
        (raw) => {
          const normalized = normalizeUpstreamEvent(raw, sessionId);
          if (normalized) {
            eventCount++;
            onEvent(normalized);
          }
        },
        sseSignal
      ).catch(() => {
        // Ignore — see comment above.
      });
    }

    let response: UpstreamMessageResponse;
    try {
      response = await fetchJson<UpstreamMessageResponse>(
        fetchFn,
        `${baseUrl}/session/${sessionId}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text }] }),
          signal
        },
        undefined
      );
    } catch (err) {
      sseAbort.abort();
      if (ssePromise) await ssePromise;

      if (signal?.aborted) {
        return { outcome: "aborted", eventCount };
      }

      // Known OpenCode headless quirk (architecture doc, "infra vs. logic
      // failure classification"): a dropped connection must never resolve
      // as 'completed', no matter how many (if any — commonly zero)
      // progress events were observed on the SSE side-channel first.
      const message = err instanceof Error ? err.message : String(err);
      throw new OpencodeTransportError(
        `opencode prompt request failed for session ${sessionId} after observing ${eventCount} progress event(s): ${message}`,
        err instanceof OpencodeTransportError ? err.status : undefined,
        err
      );
    }

    sseAbort.abort();
    if (ssePromise) await ssePromise;

    const error = response.info.error;
    if (error) {
      if (error.name === "MessageAbortedError") {
        return { outcome: "aborted", eventCount };
      }
      return { outcome: "error", error: describeUpstreamError(error), eventCount };
    }

    return { outcome: "completed", eventCount };
  }

  async function getUsageViaExport(sessionId: string): Promise<SessionUsage | undefined> {
    try {
      const stdout = await runOpencodeExport("opencode", sessionId);
      const data = JSON.parse(stdout) as { info?: UpstreamSession };
      return data.info ? sessionToUsage(data.info) : undefined;
    } catch {
      return undefined;
    }
  }

  async function getUsage(baseUrl: string, sessionId: string): Promise<SessionUsage> {
    try {
      const session = await fetchJson<UpstreamSession>(
        fetchFn,
        `${baseUrl}/session/${sessionId}`,
        { method: "GET" },
        DEFAULT_TIMEOUT_MS
      );
      return sessionToUsage(session);
    } catch (httpErr) {
      const exported = await getUsageViaExport(sessionId);
      if (exported) return exported;
      throw httpErr;
    }
  }

  return { ensureServer, ping, createSession, prompt, abort, getSessionStatus, getUsage };
}

// Re-exported so tests/callers can resolve the same real executable path
// this module uses internally, without duplicating the .cmd-shim logic.
export { resolveExecutable };
