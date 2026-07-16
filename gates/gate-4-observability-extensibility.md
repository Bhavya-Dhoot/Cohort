# Gate 4 — M4 Observability & Extensibility (Final)

**Status:** pending founder approval
**Date:** 2026-07-16
**Plan:** `C:\Users\DELL\.claude\plans\objective-you-are-no-parsed-glacier.md` · **Prev:** [gate-3](gate-3-dynamic-org.md)

## What shipped

The last milestone: a run **observability report** and proof that the platform **extends without touching core source**. This closes the 15-capability spec.

New core module: `report/` — `generateRunReport(runDir)` reads a run's on-disk artifacts (plan, task board, worker metas, cost, batches, reviews, replans, events) and renders one markdown document: summary table, mermaid **execution timeline** (gantt), mermaid **task DAG** (graph TD, colored by status), per-worker/per-model **cost table**, and an actionable **failure report** (state, infra/logic classification, last error, verify output, replan cross-reference). Exposed as the `run_report` MCP tool (18 total), which also persists `report.md`. The report degrades gracefully — a missing/malformed/partial artifact drops a section rather than throwing or emitting broken diagrams.

Extension seam added: `memory.yaml` `sections` — a project can declare custom shared-memory sections in config, read/written through the `memory` tool with no code change. `docs/EXTENDING.md` documents all five extension points.

## Spec capabilities delivered

14 (observability: timeline, task-graph visualization, worker status, model usage, cost, failure reports — all in one report). 15 (extensibility without core changes — proven by `packages/core/test/extension/extension.test.ts`, five points, each a project config override or a construction-time DI, none requiring a `packages/core/src` edit).

## Design decisions this phase

1. **Observability = a diffable markdown+mermaid artifact, not a dashboard.** Zero new deps (mermaid strings hand-rolled), works headless, renders in any editor or as a private Artifact page. No standing process.
2. **The report never trusts its inputs.** Every artifact read is guarded; on-disk values (worker `state`, review `verdict`, task/worker ids, timestamps, classification) are validated against their enums and escaped before entering markdown tables / mermaid labels — a corrupted or hand-edited artifact degrades a section, never corrupts the whole document.
3. **Extensibility is data/DI, never dynamic code.** Explicit non-goal: no `eval`/`require` of user JS anywhere in core. Every extension resolves to (a) a config value (checks, memory sections, providers), (b) a markdown agent definition Claude Code itself loads (reviewers, specialists), or (c) the `OpencodeClient` TypeScript interface satisfied at construction (worker backends).
4. **Daemon deferred** (founder decision): the Claude Code plugin form factor satisfies capability 12; the core library boundary keeps a headless daemon addable later without rework.

## Review cycle (adversarial, multi-agent)

3 Sonnet dimension reviewers (report robustness, mermaid/markdown correctness, run_report + memory seam) → 8 findings → refutation-biased verifiers → **7/8 confirmed** → fixed by 1 Sonnet agent (single-file family), each with a regression test. All 7 were the same root cause: on-disk artifact values rendered into markdown/mermaid without validation/escaping, breaking the diagram instead of degrading gracefully — now every value is enum-checked or escaped, and workers with non-numeric timestamps are dropped from the report. 350 tests green post-fix.

## E2E acceptance result

**PASSED** (`npm run m4-accept`, real OpenCode worker). One-task objective → worker ran on `opencode/hy3-free` → verified → **live custom check**: a `smoke` suite added only via a project `.agentic-os/config/orchestrator.yaml` override (deep-merged over the shipped defaults, zero code change) ran and passed (`checks=[exists]`) → `integrate_batch` merged onto `agentic/integration/run-20260716-070108` (`e357410`), regression `full` passed → `run_report` wrote `report.md` and its inline markdown byte-matched the file, containing both mermaid fences (**gantt** execution timeline + **graph TD** task DAG) and the **Model & Cost Usage** table (`summary.tasks.total=1`, `workers.total=1`). **Total committed cost: $0.** Reusable at `scripts/m4-accept.mjs`.

## Final completeness matrix (all 15 capabilities)

| # | Capability | Delivered |
|---|---|---|
| 1 | Dynamic org generation | M3 |
| 2 | Hierarchical management (data) | M1 decision, materialized M3 |
| 3 | Dynamic specialists | M3 |
| 4 | Parallel batches, file-ownership partitioning | M2 |
| 5 | Shared memory + scratchpads + context bundles | M2 (scratchpads M1) |
| 6 | Structured-artifact communication | M1→M3 |
| 7 | Continuous loop, replan caps, human gates | M2 |
| 8 | Dedicated read-only reviewers | M3 |
| 9 | Configurable check suites → replan | M2 |
| 10 | Model routing by task complexity | M1 (auto:free) + M3 downgrade |
| 11 | OpenCode worker integration (isolated worktrees) | M1 |
| 12 | Claude as CEO/planner/reviewer (plugin) | M1 + M2/M3 skill |
| 13 | YAML config + tiered budget guardrails | M1 |
| 14 | Observability (timeline/DAG/cost/failures) | **M4** |
| 15 | Extensibility without core changes | **M4** |

## Whole-build summary

- **18 MCP tools**, 16 core modules, **350 hermetic tests** (+1 env-gated smoke), typecheck + build clean.
- **4 gate artifacts**, each closed with an adversarial multi-agent review (5+5+5+3 dimension reviewers, refutation-biased verification) and a **real-token acceptance run at $0** on auto-selected free OpenCode models.
- Every implementation change made by **Sonnet subagents** on disjoint file ownership; orchestrator planned, reviewed, integrated, and owned all commits (founder's standing rule).
- Total review findings across M2–M4: 17 + 11 + 7 = **35 confirmed, all fixed with regression tests.**

## Ledger (delegate-vs-build)

| Work | Who | Why |
|---|---|---|
| report/ module | 1× Sonnet | pure, contract-scoped |
| run_report + memory seam | 1× Sonnet | server.ts single-file |
| extension proofs + EXTENDING.md | 1× Sonnet | tests + docs, disjoint |
| Review | Workflow: 3 reviewers + 8 verifiers | adversarial |
| Fixes | 1× Sonnet | single-file family |
| ARCHITECTURE.md refresh | 1× Sonnet | docs-only |
| Acceptance + gate | Sonnet script + orchestrator run | real-token proof, plan-authorship |

## Founder acceptance checklist

- [ ] `npm test` green (350 tests, no tokens)
- [ ] Optional: `npm run m4-accept` (real free-model run + custom-check override + run_report, ~$0)
- [ ] Skim this gate, `docs/EXTENDING.md`, the refreshed `docs/ARCHITECTURE.md`, a sample `report.md`
- [ ] Approve → **build complete.** All 15 spec capabilities delivered.
