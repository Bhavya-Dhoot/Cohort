# Cohort

**An autonomous AI software-engineering organization for Claude Code and OpenCode.**

[![License: MIT](https://img.shields.io/badge/license-MIT-0F766E?style=flat-square)](https://github.com/Bhavya-Dhoot/Cohort/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-8A8F98?style=flat-square)](https://nodejs.org)

Give it one objective in plain English. It plans the work into a task graph, runs
parallel OpenCode workers in isolated git worktrees, verifies each one against your
real build and test commands, gates every merge behind a read-only reviewer, and
integrates whatever passes in dependency order.

**18 MCP tools · 376 tests across 33 files · MIT**

---

## Install

```bash
npm i -g @bhavya-dhoot/cohort
```

Requires Node.js >= 22, plus the [Claude Code](https://claude.com/claude-code) and
OpenCode CLIs on your PATH.

## Quickstart

```bash
cohort login    # verifies Claude Code, OpenCode and provider auth; stores no secrets
cohort init     # scaffolds .cohort/ and registers the Claude Code plugin
cohort run "add rate limiting to the public API and cover it with tests"
```

`cohort doctor` diagnoses an environment that will not start.

## How it works

1. **Plan.** The objective becomes a task DAG. Cycles and dangling dependencies are
   rejected before any work starts.
2. **Batch.** Only tasks that are dependency-ready *and* own disjoint sets of files
   run together, so two agents never edit the same file.
3. **Isolate.** Each task gets its own git worktree and its own OpenCode session.
4. **Verify.** A real shell command — your build, your tests, your linter — runs
   against that worker's actual worktree. An agent's own claim that tests pass is
   never accepted as evidence.
5. **Review.** A reviewer subagent with `Read`, `Grep` and `Glob` and no edit tools
   returns pass, revise or block. A non-pass verdict is rejected unless it names
   concrete findings, because a reviewer that can quietly fix what it finds stops
   reporting what it found.
6. **Integrate.** Verified work merges into the run's integration branch in DAG
   order, stopping at the first conflict.

Blocked work is replanned a bounded number of times and then escalated to a human
rather than retried indefinitely. Workers run on free models by default under hard
budget ceilings, and a deny floor on push, publish and deploy cannot be relaxed by
configuration.

## When not to use it

For a one-line change, this is strictly worse than making the change yourself — you
pay for a planning step, a worktree, a verification pass and a review to save
nothing. It earns its keep when the work genuinely splits into file-disjoint pieces,
you have a test suite worth verifying against, and a mistake would be expensive or
hard to notice.

## Documentation

- [Repository and full README](https://github.com/Bhavya-Dhoot/Cohort)
- [Architecture](https://github.com/Bhavya-Dhoot/Cohort/blob/main/docs/ARCHITECTURE.md)
- [Cohort: The Operator's Guide](https://bhavyadhoot.gumroad.com/l/cohort-operators-guide)
  — a written guide to running it: the tool-by-tool lifecycle, budget tiers, replan
  escalation, and the operational failures the docs do not cover. Cohort itself stays
  free and MIT; nothing in it is gated behind the guide.

## License

[MIT](https://github.com/Bhavya-Dhoot/Cohort/blob/main/LICENSE)
