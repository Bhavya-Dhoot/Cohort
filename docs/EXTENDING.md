# Extending Agentic OS

Agentic OS is designed so that project-specific and third-party extensions
never require editing `packages/core/src`. Every extension point resolves to
one of three things:

1. **Config** — a YAML file under `<projectDir>/.agentic-os/config/`,
   deep-merged over the shipped defaults in `config/` (`config/index.ts`'s
   `loadConfig`). Objects merge key-by-key; arrays and scalars replace.
2. **A markdown agent definition** — an OpenCode agent file at
   `<projectDir>/.opencode/agent/<id>.md` (frontmatter + system-prompt body).
3. **A TypeScript interface satisfied at construction** — passed in via
   `createAgenticMcpServer({ deps })`.

**Non-goal:** there is no dynamic loading of arbitrary user JavaScript. No
extension point evaluates a project-supplied script or module at runtime —
only these three closed, inspectable shapes. This is deliberate: config and
markdown are auditable without executing them, and a DI interface is
type-checked at the call site.

Executable proof for all five extension points below lives in
`packages/core/test/extension/extension.test.ts` — each test writes a
project override (or injects a fake dependency) into a scratch `projectDir`
and drives the real MCP tool surface (or, for providers, the real config
loader) to confirm the extension takes effect, with zero change to
`packages/core/src`.

## 1. Custom check suites

**Mechanism:** `<projectDir>/.agentic-os/config/orchestrator.yaml`, key
`checks.suites` (`config/schema.ts`'s `OrchestratorFileSchema`). Consumed by
`checks/runCheckSuite` and exposed via the `run_check_suite` tool
(`mcp/server.ts`).

```yaml
checks:
  suites:
    smoke:
      - name: echo
        command: "node -e \"process.exit(0)\""
        timeoutMs: 5000
```

Call `run_check_suite({ suiteName: "smoke" })` (optionally scoped to a
`workerId` or `path`) and it runs. Suites merge additively with the shipped
`quick`/`full` suites — declaring `smoke` doesn't remove them. A project can
also point `checks.usage.verify` / `.integration` / `.regression` at its own
suite names to change which suite runs at which pipeline phase.

**No core `src` edit required.**

## 2. Custom memory sections

**Mechanism:** `<projectDir>/.agentic-os/config/memory.yaml`, key `sections`
(`config/schema.ts`'s `MemoryFileSchema`), threaded into
`openMemoryStore(dir, { sections })` (`memory/index.ts`) and exposed via the
`memory` tool.

```yaml
sections:
  - deployment-notes
```

`memory({ action: "write", section: "deployment-notes", content: "..." })`
and the matching `read` now work. Custom sections default to kind
`snapshot-md` (overwrite-in-place free text). A section name not in the
built-in defaults (`mission`, `architecture`, `contracts`, ...) and not
declared here is rejected with a clear "Unknown memory section" error —
extension is opt-in, not implicit.

**No core `src` edit required.**

## 3. Custom reviewers

**Mechanism:** two parts, both outside `packages/core/src`:

- The reviewer *subagent* is a plugin markdown agent file at
  `<projectDir>/.opencode/agent/<reviewerId>.md` — the same generated-agent
  format `specialist/index.ts` writes (frontmatter: `description`, `mode`,
  optional `model`/`temperature`/`steps`/`permission`; body: the system
  prompt). Reviewer agents are conventionally read-only
  (`permission: { "*": "deny", read: "allow" }`-style), since their only
  effect on the run is the verdict they report back.
- `review_verdict` (`mcp/server.ts`) accepts any path-safe `reviewerId`
  (`REVIEWER_ID_PATTERN` in `review/schema.ts`: `^[a-z][a-z0-9-]{0,40}$`) —
  it is never validated against a fixed roster.

```
review_verdict({ action: "record", taskId: "task-1",
                  reviewerId: "my-custom-reviewer", verdict: "pass" })
```

Adding a reviewer is: write the `.md` file, have that subagent call
`review_verdict` with its chosen id. `review_verdict({ action: "get" })`
rolls every reviewer's latest verdict into one blocking summary regardless
of which ids contributed to it.

**No core `src` edit required.**

## 4. Alternate worker backends

**Mechanism:** `createAgenticMcpServer({ deps: { client } })`
(`mcp/server.ts`), where `client` satisfies `OpencodeClient`
(`opencode-client/types.ts`: `ensureServer`, `ping`, `createSession`,
`prompt`, `abort`, `getSessionStatus`, `getUsage`). Omitting `client` uses
the real `opencode serve` HTTP client (`opencode-client/client.ts`); passing
one swaps it out entirely. The worker state machine (`worker/index.ts`)
depends only on this interface.

```ts
const server = await createAgenticMcpServer({
  projectDir, platformConfigDir,
  deps: { client: myThirdPartyBackend } // implements OpencodeClient
});
```

Every worker lifecycle tool (`spawn_worker`, `worker_status`,
`collect_worker`, ...) then drives `myThirdPartyBackend` instead of real
OpenCode — proven in the test file by a from-scratch fake whose distinct
session id and cost surface through the real tool calls.

**No core `src` edit required.**

## 5. New providers

**Mechanism:** `<projectDir>/.agentic-os/config/providers.yaml`, key
`providers` (`config/schema.ts`'s `ProvidersFileSchema` — each entry
requires `apiKeyEnv`, the *name* of an env var, never a literal key; extra
fields are allowed via `.catchall`).

```yaml
providers:
  myllm:
    apiKeyEnv: "MYLLM_KEY"
```

Loads and validates through the same `loadConfig` merge every other config
file uses, additively over the shipped `anthropic` entry. A `${MYLLM_KEY}`
placeholder elsewhere in config interpolates from `process.env.MYLLM_KEY` at
load time.

**No core `src` edit required.**
