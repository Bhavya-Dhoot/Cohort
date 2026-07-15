# agentic-os (Claude Code plugin)

Spawns and manages OpenCode implementation workers in isolated git
worktrees, exposed to Claude Code as an MCP tool surface plus the
`agentic-os` skill (see `skills/agentic-os/SKILL.md` for the worker loop).

## Prerequisite

Build the core library first — the plugin's `.mcp.json` runs the compiled
`dist/` output, not TypeScript source:

```
npm run build
```

## Register the plugin

From the repo root:

```
claude --plugin-dir F:\Agentic_os\packages\plugin
```

## MCP tools (8, from `packages/core/src/mcp/server.ts`)

`spawn_worker`, `worker_status`, `list_workers`, `stream_worker_log`,
`abort_worker`, `collect_worker`, `verify_worker`, `finalize_worker`. Full
signatures and payload shapes: `docs/ARCHITECTURE.md` ("MCP tool surface").

## Config overrides

Shipped defaults live in `config/*.yaml` at the repo root. To override any
of the five files (`orchestrator`, `models`, `agents`, `memory`,
`providers`) for a specific target project, place a same-named YAML file
under:

```
<project>/.agentic-os/config/*.yaml
```

Only the keys you set are overridden — each file is deep-merged over its
shipped default, not replaced wholesale.

## Live run monitor

`monitors/monitors.json` tails the active run's event log
(`.agentic-os/runs/<runId>/events.jsonl`) and prints new lines prefixed
`[agentic-os]` as tool calls happen, so run activity is visible without
polling `worker_status` manually.
