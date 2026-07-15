/**
 * Contract between the worker state machine and the OpenCode integration.
 *
 * The implementation wraps the `opencode serve` HTTP API and translates raw
 * OpenCode events/responses into these normalized shapes. The worker module
 * depends ONLY on this interface (mockable in tests). Implementations own all
 * OpenCode-specific details (endpoint paths, event schemas, SSE handling).
 *
 * Transport-level outcomes live here; *judging whether work succeeded* does
 * not — that is the verify module's job (worker self-reports are never
 * trusted).
 */

export interface EnsureServerOptions {
  /** Directory holding server.json (typically <project>/.agentic-os). */
  stateDir: string;
  /** Explicit port; defaults to an OS-assigned free port. */
  port?: number;
  /** Extra environment for the spawned process (e.g. OPENCODE_CONFIG_CONTENT). */
  env?: Record<string, string>;
  /** Path to the opencode binary; defaults to "opencode" on PATH. */
  binaryPath?: string;
  /** Log file for the detached server's stdout/stderr. */
  logFile?: string;
}

export interface ServerHandle {
  baseUrl: string;
  pid: number;
  /** true if this call spawned the process; false if attached to a live one. */
  spawned: boolean;
}

export interface CreateSessionOptions {
  /** Absolute path the session operates in (the worker's git worktree). */
  directory: string;
  /** OpenCode agent id (e.g. "build"). */
  agent?: string;
  /** "provider/model" string, passed through unmodified. */
  model?: string;
  title?: string;
}

export interface SessionInfo {
  id: string;
  directory: string;
  title?: string;
}

export type SessionState = 'idle' | 'busy' | 'unknown';

export interface SessionStatus {
  id: string;
  state: SessionState;
}

/**
 * Transport-level outcome of a prompt turn. 'completed' means the server
 * reported the turn finished — it says nothing about whether the work is
 * correct.
 */
export interface PromptResult {
  outcome: 'completed' | 'error' | 'aborted';
  /** Present when outcome === 'error'. */
  error?: string;
  /** Count of assistant/tool events observed during the turn, if known. */
  eventCount?: number;
}

export interface SessionUsage {
  costUsd?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Files changed / additions / deletions as reported by OpenCode, if known. */
  summary?: { files?: number; additions?: number; deletions?: number };
}

/** Normalized progress event, stored verbatim into the worker's events.jsonl. */
export interface NormalizedEvent {
  ts: number;
  kind: 'message' | 'tool' | 'error' | 'idle' | 'other';
  /** One-line human-readable summary for logs/monitors. */
  summary: string;
  /** Raw upstream payload for debugging; may be omitted or truncated. */
  raw?: unknown;
}

/** Thrown by implementations on HTTP/transport failures (infra-classified). */
export class OpencodeTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OpencodeTransportError';
  }
}

export interface OpencodeClient {
  /**
   * Attach to the server recorded in stateDir/server.json if its PID is alive
   * and it responds to a probe; otherwise spawn `opencode serve` DETACHED
   * (survives the caller's death) and persist server.json atomically.
   */
  ensureServer(opts: EnsureServerOptions): Promise<ServerHandle>;

  /** Cheap liveness probe of a server (e.g. GET /doc). */
  ping(baseUrl: string): Promise<boolean>;

  createSession(baseUrl: string, opts: CreateSessionOptions): Promise<SessionInfo>;

  /**
   * Send a prompt and resolve when the turn finishes (or the signal aborts).
   * Implementations must be robust to the known OpenCode headless quirks:
   * a dropped stream with zero observed events is a transport error, not a
   * completed turn.
   */
  prompt(
    baseUrl: string,
    sessionId: string,
    text: string,
    opts?: { signal?: AbortSignal; onEvent?: (evt: NormalizedEvent) => void },
  ): Promise<PromptResult>;

  abort(baseUrl: string, sessionId: string): Promise<void>;

  /** Poll session state — used for crash reconciliation after restarts. */
  getSessionStatus(baseUrl: string, sessionId: string): Promise<SessionStatus>;

  /** Cost/token usage for a session (server API or `opencode export`). */
  getUsage(baseUrl: string, sessionId: string): Promise<SessionUsage>;
}
