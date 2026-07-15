# Agentic OS

Agentic OS is an orchestration platform that turns a single objective (e.g.
"Build an AI CRM with OAuth, Stripe, Docker, PostgreSQL and CI/CD") into a
completed software project autonomously. Claude Code acts as CEO/architect/
planner/reviewer and never writes implementation code itself; isolated
OpenCode CLI workers, spawned into their own git worktrees, do the
implementation under continuous verification, budget guardrails, and human
gates at plan-approval and pre-merge.

## Status

**M1 in progress** — the OpenCode worker layer (spawn/monitor/verify/merge
isolated worktree workers via MCP tools). See `docs/ARCHITECTURE.md` for the
full milestone breakdown.

## Repo layout

```
packages/core/src/{config,worktree,opencode-client,worker,events,tasks,
                    budget,verify,mcp,memory,specialist,plugin}/
packages/core/test/
packages/plugin/           (added in M1 step 10)
config/                    (shipped default YAML — added alongside config/)
docs/ARCHITECTURE.md
package.json / tsconfig.base.json / vitest.config.ts
```

## Running tests

```
npm install
npm run typecheck
npm test
```

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design:
principles, module responsibilities, worker lifecycle, execution pipeline,
state/persistence model, MCP tool surface, and configuration.
