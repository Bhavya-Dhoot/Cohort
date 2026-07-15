# OpenCode HTTP API — discovery notes (opencode 1.15.13, Windows)

Derived by running a real `opencode serve` locally and reading its live
`GET /doc` OpenAPI 3.1 spec (283KB). Corrections to the architecture doc's
assumptions are called out explicitly.

## Executable resolution (Windows)

`opencode` on PATH resolves (via `where opencode`) to TWO candidates: a
POSIX shell wrapper with no extension, and `opencode.cmd`. Node's
`child_process.spawn` cannot exec `.cmd`/`.bat` directly when `shell` is not
`true` — it throws `EINVAL` **synchronously** (verified empirically). The
`.cmd` shim's body is just:
`"%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*`
so `binary.ts` reads the shim, extracts the `%dp0%\...\*.exe` path, and
spawns that `.exe` directly with `shell:false`. This avoids an extra
`cmd.exe` process in the tree (cleaner PID for liveness checks and
`taskkill`) and avoids shell quoting entirely. Falls back to `shell:true`
against the original path only if no `.exe` can be extracted.

## Health / ping

`GET /global/health` → `{"healthy":true,"version":"1.15.13"}` — small,
fast, used for `ping()` instead of the 283KB `/doc` payload (task allowed
"or cheaper discovered health route"). `GET /doc` also confirmed to always
return `application/json` on GET (not HTML — a HEAD request returns a
different/unrelated response, so `ping()` must issue GET, not HEAD).

## Session endpoints (base path `/session`, NOT `/api/session/*`)

The plain (v1) session API is used throughout, not the `/api/session/*` v2
API (`v2.session.prompt`, `v2.session.wait`) which also exists but is a
separate, newer surface with different response shapes (`SessionMessage`,
cursor-paginated messages). v1 was chosen because it matches the
architecture doc's assumed shape and is simpler for a blocking prompt call.

- `POST /session?directory=<dir>` — create session. Body:
  `{title?, agent?, model?: {id, providerID, variant?}, parentID?, metadata?, permission?}`.
  Response: `Session` (see below). **Matches assumption.**
- `GET /session?directory=<dir>` — list sessions. **Matches assumption**
  (architecture doc didn't call this out explicitly but it exists as
  documented).
- `GET /session/{sessionID}` — get one session (includes `cost`, `tokens`,
  `summary{additions,deletions,files}`). **Matches assumption**; also
  doubles as the `getUsage` data source (see below).
- `DELETE /session/{sessionID}` — delete session, returns boolean.
  Confirmed idempotent-safe path for cleanup; not in the original contract
  surface but exercised in Phase A.
- `POST /session/{sessionID}/abort` → `true`/`false`. **Matches
  assumption** (`POST /session/:id/abort`).
- `POST /session/{sessionID}/message` — **this is the sync "send prompt"
  endpoint**, not `/prompt`. Body: `{parts: [{type:"text", text}], agent?,
  model?: {providerID, modelID}, ...}`. Despite its OpenAPI summary text
  ("streaming the AI response"), the response `Content-Type` is
  `application/json`, not `text/event-stream` — it is a single **long-lived
  blocking POST** that resolves once the turn finishes, returning
  `{info: AssistantMessage, parts: Part[]}`. `AssistantMessage.error` (if
  present) is one of `ProviderAuthError | UnknownError |
  MessageOutputLengthError | MessageAbortedError | StructuredOutputError |
  ContextOverflowError | APIError`, each shaped `{name, data:{message,...}}`.
  `MessageAbortedError` is treated as `outcome:'aborted'`; any other
  `.error` as `outcome:'error'`. **Corrects the architecture doc's implied
  `prompt`/`prompt_async` split**: `/message` is what we use for the
  synchronous call the contract's `prompt()` needs.
- `POST /session/{sessionID}/prompt_async` → `204 No Content`, "starting
  the session if needed and returning immediately." **Matches assumption**
  (exists exactly at the assumed path) but is NOT used by `prompt()` since
  the contract needs a value to resolve on completion; exported as an
  unused-but-documented fact for future fire-and-forget use cases.
- `GET /session/status` — **not** `GET /session/{id}/status`. Returns an
  object **keyed by session ID** → `SessionStatus`, but **only for sessions
  with a non-idle/newsworthy status**: an idle session created fresh is
  simply **absent from the map** (verified empirically: a brand-new session
  produced `{}`). `SessionStatus` is `{type:'idle'}` (only appears for a
  session that was previously busy and just became idle — see event stream)
  `| {type:'busy'} | {type:'retry', attempt, message, next, ...}`.
  **Derivation used in `getSessionStatus`:** entry absent from map → `idle`;
  `type:'idle'` → `idle`; `type:'busy'` or `type:'retry'` → `busy`; anything
  else → `unknown`. This corrects the architecture doc's assumption of a
  per-session status endpoint.

## Event stream

`GET /event?directory=<dir>` → `text/event-stream`, chunked, one JSON
object per event as `data: {...}\n\n` (standard SSE, no `event:`/`id:`
framing observed — parser splits on blank line and reads `data:` lines).
**Matches assumption** (`GET /event`). Sample first event on connect:
`{"id":"evt_...","type":"server.connected","properties":{}}`.

Event envelope: `{id, type, properties}`. Relevant types used for
normalization (subset of a ~90-member union):
- `message.updated` → `properties.{sessionID, info: Message}`
- `message.part.updated` → `properties.{sessionID, part: Part, time}`
  (`Part.type` includes `text`, `tool`, `reasoning`, `file`, ...; `ToolPart`
  has `{tool, callID, state: ToolState}` where `ToolState` is
  `pending|running|completed|error`, each carrying a `status` discriminant)
- `session.error` → `properties.{sessionID, error}` (same error union as
  `AssistantMessage.error`)
- `session.idle` → `properties.{sessionID}`
- `session.status` → `properties.{sessionID, status: SessionStatus}`

Events without a `sessionID` in `properties` (e.g. `server.connected`) are
dropped by the normalizer rather than surfaced as `'other'`, to avoid cross-
session noise when multiple workers share one `opencode serve` instance.

## Usage / cost fields

`Session` (from `GET /session/{id}` and the create/list responses) carries
`cost: number` and `tokens: {input, output, reasoning, cache:{read,write}}`
directly — no need to sum per-message costs. `Session.summary` carries
`{additions, deletions, files}`. This is the primary source for
`getUsage()`.

`opencode export <sessionID>` (run via `execFile`, no `--attach` flag
exists on 1.15.13 — the task brief's mention of `--attach-less` just means
it works against local session storage without needing to reach the HTTP
server) prints `{info: Session, messages: [...]}` to stdout — same `Session`
shape as above under `.info`. Verified live against a real (promptless)
session. Used only as a fallback when the HTTP `GET /session/{id}` call
itself fails (server unreachable).

## Spawn / detach behavior (verified live)

`spawn(exePath, ["serve","--port",port,"--hostname","127.0.0.1"], {detached:true, stdio:["ignore", logFd, logFd], windowsHide:true}).unref()`
followed by immediate parent `process.exit()` leaves the child running and
reachable over HTTP — confirmed via `tasklist` + `curl` against
`/global/health` in a fresh shell after the spawning process had already
exited. `taskkill /PID <pid> /T /F` cleanly terminates it.
