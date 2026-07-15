# Gate 3 — M3 Dynamic Organization, Specialists & Reviewers

**Status:** pending founder approval
**Date:** 2026-07-15
**Plan:** `C:\Users\DELL\.claude\plans\objective-you-are-no-parsed-glacier.md` · **Prev:** [gate-2](gate-2-multi-worker-pipeline.md)

## What shipped

Dynamic organization generation and the dedicated reviewer pipeline — the pieces that make each project produce a *different* engineering org. A plan now carries generated `domains` and an `orgChart` (CEO → EM → Domain Leads → Specialists → Reviewers → Integration); the platform generates OpenCode specialist agents on demand and retires them, and every batch can be gated by read-only reviewer subagents whose verdicts must cite real findings.

New core modules: `specialist/` (writes/retires `.opencode/agent/<id>.md` in the target project, deny-floor enforced), `review/` (verdict store + schema that rejects a non-`pass` verdict with no findings), org-chart schema in `plan/`. Two new MCP tools (17 total): `specialist` (generate/retire/list), `review_verdict` (record/get). `spawn_worker` gained soft-cap model auto-downgrade. Plugin: 7 read-only reviewer subagents (`packages/plugin/agents/*.md`, tools = `Read, Grep, Glob, mcp__agentic-os__review_verdict`) + the skill's org/specialist/reviewer flow.

## Spec capabilities delivered

1 (dynamic org generation — domains/experts/order derived per objective), 2 (hierarchy as generated data; Claude plays CEO/EM/leads in-session, specialists are OpenCode agents, reviewers are subagents), 3 (specialist create-when-required / destroy-when-done, with a `max_concurrent_specialists` cap), 8 (dedicated per-discipline reviewers that structurally cannot write code — no Edit/Write/Bash tool). Model routing by task complexity (10) is now exercised end-to-end via `taskType` + soft-cap downgrade.

## Design decisions this phase

1. **Hierarchy is data, materialized as an org-chart artifact** (locked since M1). `validateOrgReferences` gates `plan_submit`: an org node or task referencing an undeclared domain is rejected before persistence; org nesting is depth-capped (iterative check, no stack-overflow on hostile input).
2. **"Reviewers never write" = a capability boundary, not a prompt.** Reviewer subagents get only read tools plus the `review_verdict` MCP tool (write a verdict, never code). A `block` or unaddressed `revise` gates integration.
3. **Anti-rubber-stamp enforced in the schema:** a `revise`/`block` verdict must carry ≥1 finding, and finding notes must have real content (trimmed length ≥ 8) — a lazy pass-through can't be recorded.
4. **Deny-floor is glob-aware and floor-wins:** a specialist spec can't relax a floor deny even with a differently-worded overlapping key; `retireSpecialist` only deletes files stamped `generatedBy: agentic-os` (won't clobber a user's hand-written agent).
5. **Specialist generation serialized** so the concurrency cap can't be raced past.

## Review cycle (adversarial, multi-agent)

5 Sonnet dimension reviewers (specialist-safety, review-integrity, org-schema, budget-downgrade, reviewer-plugin/skill) → 11 findings → refutation-biased verifiers → **11/11 confirmed** → fixed by 4 parallel Sonnet agents (disjoint files), each with regression tests. The **critical** find: the 7 reviewers were locked to `Read, Grep, Glob` and thus couldn't call `review_verdict` to record anything — the whole review gate was inert; fixed by granting the verdict tool (still no code-edit tools). Also fixed: `validateOrgReferences` was dead code (now gates persistence), specialist cap TOCTOU, deny-floor glob bypass, retire deleting non-generated files. 335 tests green post-fix (a pre-existing flaky opencode-client timeout was also stabilized).

## Known gaps / M4 inputs

- `run_report` is referenced conceptually but ships in M4; the skill no longer instructs calling it.
- Reviewer subagents are dispatched by the skill (Claude Task tool) — the M3 acceptance records representative verdicts directly through the tool to prove the store + gating deterministically; a live reviewer-subagent dispatch is exercised in normal plugin use.

## E2E acceptance result

**PASSED** (`npm run m3-accept`, real OpenCode workers). Two-domain objective → `plan_submit` with `domains: [config, health]` + a CEO-rooted `orgChart` → **org validated** (validateOrgReferences passed) → `specialist(generate)` created `config-engineer` and `health-engineer` (`.opencode/agent/*.md` written, deny-floor present) → `next_batch` → both tasks spawned **as their specialist** (`spawn_worker … agentId`) on `opencode/hy3-free` → completed + verified → reviewer verdicts recorded via `review_verdict` (`architecture`/`testing` → pass, `blocking=false`) → **anti-rubber-stamp guard proven**: a `block` verdict with empty findings was rejected (`isError`, "a non-pass verdict must cite at least one finding") → `integrate_batch` merged both onto `agentic/integration/run-20260715-141201` (head `6e6db48`), regression `full` passed → `src/config.js` + `src/health.js` confirmed on the integration branch → both specialists retired (`removed:true`, files gone). **Total committed cost: $0.** Reusable at `scripts/m3-accept.mjs`.

This run doubles as the spec's end-to-end proof: a single objective in → org generated → specialists spawned → parallel work → reviews → integration, with no manual task assignment.

## Ledger (delegate-vs-build)

| Work | Who | Why |
|---|---|---|
| M3 design | Sonnet Plan agent + orchestrator | folded into the M2–M4 completion design |
| Wave A (specialist, review, org-schema, auto-commit fix) | 4× Sonnet, disjoint files | independent, contract-scoped |
| Wave B (2 tools + downgrade) | 1× Sonnet | single-file (server.ts) |
| Wave C (7 reviewers + skill) | 2× Sonnet | plugin-only, disjoint from core |
| Review | Workflow: 5 reviewers + 11 verifiers | adversarial |
| Fixes | 4× Sonnet, one per file | scoped, regression-tested |
| Acceptance + gate | Sonnet run + orchestrator | real-token proof, plan-authorship |

## Founder acceptance checklist

- [ ] `npm test` green (335 tests, no tokens)
- [ ] Optional: `npm run m3-accept` (real free-model org+specialist+reviewer loop, ~$0)
- [ ] Skim this gate + the updated skill + a couple of `packages/plugin/agents/*.md`
- [ ] Approve → M4 (observability report generator, extension-point proofs) — the final milestone
