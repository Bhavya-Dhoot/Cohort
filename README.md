<div align="center">

<img src="docs/assets/hero.svg" alt="Animated diagram: a central orchestrator node draws lines out to four specialist nodes and one reviewer node, which assemble one at a time, followed by a review pulse and an integrate beat, then the organization holds fully assembled before the cycle repeats" width="560" />

# Cohort

**An autonomous AI software-engineering organization for Claude Code and OpenCode.**

[![npm](https://img.shields.io/badge/npm-%40bhavya--dhoot%2Fcohort-8A8F98?style=flat-square)](https://www.npmjs.com/package/@bhavya-dhoot/cohort)
[![License: MIT](https://img.shields.io/badge/license-MIT-0F766E?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-8A8F98?style=flat-square)](packages/cli/package.json)
[![Tests](https://img.shields.io/badge/tests-375%20passing-0F766E?style=flat-square)](#proof-it-works)
[![Built with](https://img.shields.io/badge/built%20with-Claude%20Code%20%2B%20OpenCode-8A8F98?style=flat-square)](docs/ARCHITECTURE.md)

Give it one objective in plain English. It plans the work, builds the org
to do it, and gates every merge behind independent review.

**18 MCP tools &middot; 375 tests &middot; 15/15 spec capabilities &middot; a real $0 end-to-end run &middot; adversarial multi-agent review**

</div>

Cohort is an autonomous, multi-agent orchestration layer for software
engineering: give it one objective and it generates a bespoke engineering
org for the task at hand (domains, specialists, reviewers), runs parallel
OpenCode workers in isolated git worktrees, puts their work through code
review by dedicated read-only reviewer agents, integrates whatever passes
review, and replans whatever does not. Claude Code is the CEO, planner and
reviewer throughout; it never writes implementation code itself.
Deterministic mechanics, worktree management, budget guardrails,
verification and merge order, live behind an 18-tool stdio MCP surface, not
in the model's judgment.

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture diagram: Claude Code, as CEO, planner and reviewer, drives an 18-tool MCP tool surface, which spawns OpenCode workers in isolated git worktrees, whose diffs are checked by read-only reviewers before merging to the integration branch" width="820" />
</p>

## Quickstart

Prerequisites: [Claude Code CLI](https://claude.com/claude-code), the
[OpenCode CLI](https://opencode.ai), and Node.js >= 22.

```bash
npm i -g @bhavya-dhoot/cohort
cohort login    # verifies Claude Code + OpenCode + provider auth, never stores secrets
cohort init     # scaffolds .cohort/ config and registers the Claude Code plugin
cohort run "Build a small Node utility library: a config loader, an input validator, and a health-check handler"
```

`cohort run` walks the full loop below: plan, generate org, spawn parallel
specialists, review, integrate. You approve the plan before any worker
spawns, and you approve the integration diff before it merges.

## How it works

<p align="center">
  <img src="docs/assets/loop.svg" alt="The Cohort loop: analyze, plan, generate org and specialists, batch spawn, verify, review, integrate, replan, then repeat" width="380" />
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

## Proof it works

A real end-to-end run, not a hermetic test: Claude drove the actual MCP
tools against a fresh throwaway project, generating a live org (CEO,
engineering manager, three domain leads, three specialists, reviewers,
integration) on the auto-selected free OpenCode model, at **$0.00**. Three
parallel OpenCode workers built in isolated worktrees; three live Claude
reviewer subagents then caught a real bug, an inconsistent module system
(ESM `export` in a CommonJS project) in two of the three modules, and
blocked them instead of merging. The correct module shipped, the other two
were replanned. Full writeup: [`docs/DEMO-RUN.md`](docs/DEMO-RUN.md).

| Metric | Value |
|---|---|
| Tasks (total / done / failed / pending) | 3 / 1 / 0 / 2 |
| Workers (total / merged / failed) | 3 / 0 / 0 |
| Cost (committed / tier) | $0.0000 / ok |
| Reviews (total / blocking) | 6 / 2 |
| Duration | 8m 57s |

One of three modules shipped; two were correctly blocked by review and
queued for replan. That is the review gate working as designed, not a
partial failure. The same run also surfaced and fixed 2 real Windows
worktree bugs (a transient handle-lock on removal, and a stale worktree
registration) that the hermetic test suite had not exercised.

## Capabilities

All 15 capabilities in the build spec, delivered:

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

## Architecture

16 core modules behind the MCP surface: worktree management, verification,
review, memory, budget, model routing and more. Full design, principles,
worker lifecycle, execution pipeline, state model and the complete tool
surface: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Extensibility

Five shipped YAML files under `config/` (`orchestrator`, `models`,
`agents`, `memory`, `providers`), each overridable per project in
`.cohort/config/`. Custom check suites, memory sections, reviewers, worker
backends and providers each resolve to plain YAML config, a markdown agent
file, or a TypeScript interface satisfied at construction, with no edits to
`packages/core/src`. See [`docs/EXTENDING.md`](docs/EXTENDING.md).

## Safety

Workers run on free models by default, under hard budget ceilings.
Verification never trusts a worker's self-report; it runs real commands
against the worktree diff. Reviewers are read-only. No secrets are stored;
authentication goes through each provider's own login flow.

## License

[MIT](LICENSE)

---

<div align="center">

[Repository](https://github.com/Bhavya-Dhoot/Cohort) &middot; [npm](https://www.npmjs.com/package/@bhavya-dhoot/cohort) &middot; [Site](https://bhavya-dhoot.github.io/Cohort/)

</div>
