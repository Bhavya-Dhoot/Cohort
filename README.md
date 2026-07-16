<div align="center">

<img src="docs/assets/logo.svg" alt="Cohort logo: a central orchestrator node linked to five specialist nodes" width="320" />

# Cohort

**An autonomous AI software-engineering organization for Claude Code + OpenCode.**

[![License: MIT](https://img.shields.io/badge/license-MIT-0F766E?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-8A8F98?style=flat-square)](package.json)
[![Tests](https://img.shields.io/badge/tests-356%20passing-0F766E?style=flat-square)](#proof-it-works)
[![Built with](https://img.shields.io/badge/built%20with-Claude%20Code%20%2B%20OpenCode-8A8F98?style=flat-square)](docs/ARCHITECTURE.md)

</div>

Cohort is an autonomous, multi-agent orchestration layer for software
engineering: give it one objective in plain English and it generates a
bespoke engineering org for the task at hand (domains, specialists,
reviewers), runs parallel OpenCode workers in isolated git worktrees, puts
their work through code review by dedicated read-only reviewer agents,
integrates whatever passes review, and replans whatever does not. Claude
Code is the CEO, planner and reviewer throughout; it never writes
implementation code itself. Deterministic mechanics, worktree management,
budget guardrails, verification and merge order, live behind an 18-tool
stdio MCP surface, not in the model's judgment.

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture: Claude Code drives an MCP tool surface, which spawns OpenCode workers in isolated git worktrees, checked by read-only reviewers, merged to an integration branch" width="820" />
</p>

## Quickstart

Prerequisites: [Claude Code CLI](https://claude.com/claude-code), the
[OpenCode CLI](https://opencode.ai), and Node.js >= 22.

```bash
npm i -g cohort
cohort login    # verifies Claude + OpenCode + provider auth, never stores secrets
cohort init     # scaffolds .cohort/ config and registers the Claude Code plugin
cohort run "Build a small Node utility library with a config loader and a validator"
```

`cohort run` walks the full loop below. You approve the plan before any
worker spawns, and you approve the integration diff before it merges.

## How it works

<p align="center">
  <img src="docs/assets/loop.svg" alt="The Cohort loop: analyze, plan, generate org, batch spawn, verify, review, integrate, replan, then repeat" width="360" />
</p>

1. **Analyze** the objective into a brief.
2. **Plan** a task DAG, contracts and file-ownership partitions, plus an
   org chart sized to the objective. Human gate: plan approval.
3. **Generate org**, on-demand `.opencode/agent/*.md` specialists for the
   roles the plan needs.
4. **Batch spawn** DAG-ready, file-ownership-disjoint tasks as isolated
   OpenCode workers, each in its own git worktree.
5. **Verify** every worker independently, by running real build/test/lint
   commands against its worktree diff, never by trusting its self-report.
6. **Review** the verified diffs with dedicated read-only reviewer agents,
   whose verdicts (pass, revise, block) gate what merges.
7. **Integrate** passing work onto the run's integration branch in DAG
   order, then run a full regression suite.
8. **Replan** whatever was blocked, scoped to only the affected subtree and
   capped at a few iterations before mandatory human escalation, then
   repeat from batch spawn until the DAG is done.

## Capabilities

| Capability | What it means |
|---|---|
| Dynamic org generation | Domains, roles and headcount are derived per objective, not hardcoded |
| Hierarchical org-as-data | The org chart is a versioned, inspectable plan artifact, not standing manager processes |
| Dynamic specialists | `.opencode/agent/*.md` files generated and retired per run, deny-floor permissions always merged in |
| Parallel isolated workers | Each OpenCode worker runs in its own git worktree with disjoint file ownership |
| Shared memory | Token-capped context bundles and append-only sections shared across the run |
| Structured-artifact comms | Task cards, contracts and verdicts are schema-validated JSON, never raw transcript |
| Continuous replan loop + human gates | Plan-approval and pre-merge gates, capped replan with mandatory escalation |
| Dedicated read-only reviewers | Cross-model review agents with real gating power, not rubber-stamping |
| Configurable check suites | Named, config-defined command suites are the only source of truth for pass/fail |
| Model routing | Task-type-aware routing with soft-cap downgrade to a smaller model |
| OpenCode integration | Workers driven over `opencode serve`'s HTTP API, not ad hoc subprocesses |
| Claude orchestration | Claude Code is CEO, planner and reviewer, packaged as a Claude Code plugin |
| YAML config + budget guardrails | Five shipped config files, tiered soft-cap/hard-cap cost ceilings |
| Observability report | One markdown+mermaid report: timeline, task DAG, cost, failures |
| Extensibility | Five extension points, zero `packages/core/src` edits required |

## Proof it works

A real end-to-end run, not a hermetic test: Claude drove the actual MCP
tools against a fresh throwaway project, on the auto-selected free OpenCode
model, at **$0.00**. The live reviewers caught a genuine bug, a module-system
mismatch that would have thrown at runtime, and blocked it instead of
merging it. Full writeup: [`docs/DEMO-RUN.md`](docs/DEMO-RUN.md).

| Metric | Value |
|---|---|
| Tasks (total / done / failed / pending) | 3 / 1 / 0 / 2 |
| Workers (total / merged / failed) | 3 / 0 / 0 |
| Cost (committed / tier) | $0.0000 / ok |
| Reviews (total / blocking) | 6 / 2 |
| Duration | 8m 57s |

One of three modules shipped; two were correctly blocked by review and
queued for replan. That is the review gate working as designed, not a
partial failure.

## Configuration and extensibility

Five shipped YAML files under `config/` (`orchestrator`, `models`, `agents`,
`memory`, `providers`), each overridable per project in
`.cohort/config/`. Five extension points, custom check suites, custom
memory sections, custom reviewers, alternate worker backends and new
providers, resolve to plain YAML config, a markdown agent file, or a
TypeScript interface satisfied at construction, with no edits to
`packages/core/src`. See [`docs/EXTENDING.md`](docs/EXTENDING.md).

## Safety

Workers run on free models by default and are held to hard budget ceilings.
Verification never trusts a worker's self-report, it runs real commands
against the worktree diff. Reviewers are read-only. No secrets are stored,
authentication goes through each provider's own login flow.

## Architecture

Full design, principles, module responsibilities, worker lifecycle,
execution pipeline, state model and MCP tool surface:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
