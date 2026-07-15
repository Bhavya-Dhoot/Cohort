# Gate 2 — M2 Multi-Worker Pipeline

**Status:** pending founder approval
**Date:** 2026-07-15
**Plan:** `C:\Users\DELL\.claude\plans\objective-you-are-no-parsed-glacier.md` · **Prev:** [gate-1](gate-1-worker-layer.md)

## What shipped

The continuous multi-worker pipeline on top of M1's single-worker primitives. Claude can now hand the platform an objective decomposed into a task DAG and have it dispatch file-ownership-disjoint batches of OpenCode workers in parallel, verify each, merge verified work into a per-run integration branch in dependency order, run a regression check suite, and re-plan on failure under a hard cap.

New core modules: `tasks/{schema,dag}` (task cards + `validateDag` + `selectBatch`), `memory/` (shared sections + token-capped context bundles), `checks/` (named command suites), `worktree/integration.ts` (integration branch + DAG-ordered merge), `plan/schema` (plan/contract/replan/batch artifacts). Seven new MCP tools (18 total): `plan_submit`, `next_batch`, `batch_status`, `integrate_batch`, `run_check_suite`, `memory`, `replan_record`. The plugin skill now documents the full analyze→plan→batch→review→integrate→replan loop with both human gates.

## Spec capabilities delivered

4 (parallel batches + file-ownership partitioning), 5 (shared memory + context bundles; worktree scratchpads since M1), 6 (more structured artifacts on the events bus), 7 (continuous loop + replan cap + gate wiring), 9 (configurable check suites → replan on failure). Data-driven config additions: `orchestrator.yaml` `checks:` block; `memory.yaml` section allow-list is the extension seam.

## Decisions this phase

1. **`selectBatch` conservative overlap:** `globsOverlap` may only ever err toward "overlap" (serialize), never toward a false "disjoint" — a false negative would let two workers write the same file. Hardened against case, separator, and brace/bracket false-negatives (review findings).
2. **Integration is sequential, stop-on-conflict:** `mergeInDagOrder` merges in caller-supplied DAG order and halts at the first conflict, leaving the rest for replan. `integrate_batch` runs regression in a throwaway worktree of the integration branch, restoring the project checkout to base on every exit path.
3. **All repo-mutating tools serialized:** `integrate_batch` and `finalize_worker('merge')` share one per-run "repo-mutation" chain; replan-iteration and artifact-index counters serialized likewise — closes the TOCTOU races the review found.
4. **Replan validates before persisting:** `replan_record` runs `validateDag` over existing + new cards and enforces `replan.maxIterations`, escalating (recording nothing) at the cap.
5. **JSONL/JSON still, no SQLite** (design pass confirmed `node:sqlite` now loads flag-free on this Node, but task-board scale needs no relational query).

## Review cycle (adversarial, multi-agent)

5 Sonnet dimension reviewers (DAG/batch, integration/git-state, replan/budget, artifact/path-safety, MCP contract) → 17 findings → 17 refutation-biased verifiers → **17/17 confirmed** → fixed by 4 parallel Sonnet agents (one per file), each with a regression test. Highlights: three separate `globsOverlap` false-negative holes (the batch-safety invariant); replan iteration-counter TOCTOU that could bypass the cap; `next_batch` orphaning tasks as `assigned` when a spawn is budget-refused; `integrate_batch` stranding a batch at `integrating` on a detached HEAD or unknown suite. 238 tests green post-fix.

## Known gap found in acceptance (fix scheduled)

`integrate_batch`'s merge path (`mergeInDagOrder` → `mergeBranch`) merges each worker branch **as-is with no auto-commit**, unlike `finalize_worker`'s path which does `git add -A && git commit` first. A worker that creates files but never commits them passes `verify_worker` (filesystem check) yet integrates an empty diff, reported as success. The acceptance script works around it by instructing workers to self-commit; the principled fix — auto-commit each verified worker's worktree before merge, matching `finalize_worker` — is scheduled as the first item of M3 (or a fast follow), with a regression test asserting a non-committing worker's file still lands on the integration branch.

## E2E acceptance result

**PASSED** (`npm run m2-accept`, real OpenCode workers). Objective → 3 disjoint-ownership tasks → `plan_submit` → `next_batch` returned all 3 ready → 3 workers spawned and ran **concurrently** on `opencode/hy3-free` (free) → each completed and `verify_worker`-passed → `integrate_batch` merged all three onto `agentic/integration/run-20260715-131535` in DAG order (3 distinct merge SHAs, head `19ace76`) → `full` regression suite passed → `batch_status` = integrated. `src/a.js`, `src/b.js`, `src/c.js` all confirmed present on the integration branch via `git cat-file`. **Total committed cost: $0.** Reusable at `scripts/m2-accept.mjs` (`npm run m2-accept`).

## Deltas from plan

- `next_batch` doesn't pass `excludeTaskIds` to `selectBatch` (would double-suppress from the overlap baseline; `selectBatch` partitions by status internally).
- `batch_status`/`integrate_batch` join tasks→workers by scanning `WorkerMeta.taskId` (no `TaskCard.workerId` field is populated by in-scope tools).
- `integrate_batch` marks cards `done`/`failed` on merge outcome (needed for cross-batch DAG progression; not explicitly specified).
- Skill references reviewer subagents and `run_report` (land in M3/M4) — the loop doc is complete ahead of those pieces; harmless since the M2 acceptance drives tools directly.

## Ledger (delegate-vs-build)

| Work | Who | Why |
|---|---|---|
| M2 design | Sonnet Plan agent + orchestrator synthesis | wide surface; orchestrator owned final calls |
| Wave A (4 modules) | 4× Sonnet, disjoint files | independent, contract-scoped |
| Wave B (7 tools + schema) | 1× Sonnet | single-file serialization point (server.ts) |
| Wave C (skill) | Orchestrator | prose, exact tool contracts in hand |
| Review | Workflow: 5 reviewers + 17 verifiers | adversarial vs rubber-stamping |
| Fixes | 4× Sonnet, one per file | scoped, regression-tested |
| Acceptance script + run | Sonnet + orchestrator re-run | real-token proof |
| Gate artifact | Orchestrator | plan-authorship tier |

## Founder acceptance checklist

- [ ] `npm test` green (238 tests, no tokens)
- [ ] Optional: `npm run m2-accept` (real free-model 3-worker pipeline, ~$0)
- [ ] Skim this gate + the updated skill
- [ ] Approve → M3 (dynamic org generation, specialists, reviewer pipeline) — starting with the auto-commit-before-integrate fix above
