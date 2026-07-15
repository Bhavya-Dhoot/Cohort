# Gate 1 — M1 Worker Layer

**Status:** pending founder approval
**Date:** 2026-07-15
**Plan:** `C:\Users\DELL\.claude\plans\objective-you-are-no-parsed-glacier.md` · **Architecture:** [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

## What shipped

The complete M1 worker layer: Claude Code can spawn, monitor, verify, and merge OpenCode CLI workers running in isolated git worktrees, via 8 MCP tools backed by a tested TypeScript core.

- `packages/core` — 9 modules (config, worktree, events, tasks, budget, verify, opencode-client, worker, mcp), 113 passing tests + 1 env-gated live integration test, zero-LLM hermetic suite (`npm test`), strict TS.
- `packages/plugin` — Claude Code plugin bundling the MCP server, an `agentic-os` skill (worker-loop procedure), and a run-events background monitor.
- `scripts/smoke.mjs` (`npm run smoke`) — opt-in real-token E2E: spawn → status → verify → finalize-merge on a scratch repo.
- Shipped default config in `config/*.yaml` (budget caps 5/20 USD, worker 3×30min×3 retries, replan cap 2, both human gates on).

## Decisions made this phase

1. **`opencode serve` HTTP + hand-rolled fetch client, no `@opencode-ai/sdk` dep.** The surface is 6 endpoints; the normalized `OpencodeClient` contract insulates the worker layer; one less dependency to track against opencode's release cadence.
2. **Live-verified API corrections** (vs docs-derived plan assumptions): sync prompt = blocking `POST /session/{id}/message`; busy/idle from `GET /session/status` map (omits idle sessions); `GET /global/health` for pings; `Session` carries cost/tokens directly. Recorded in `packages/core/src/opencode-client/docs-notes.md`.
3. **Windows spawn strategy:** parse the npm `.cmd` shim for the real `opencode.exe` (last-`%dp0%`-occurrence rule, validated against real shims), fall back to `shell:true`; detached spawn + log-file stdio survives Claude Code restarts.
4. **JSONL/JSON on disk, no SQLite** (as planned) — confirmed workable; atomic temp+rename everywhere, including the events torn-tail heal.
5. **Detached-HEAD repos rejected at spawn** (M1): merge targets need a real branch; fail fast with a clear message.
6. **Cross-process safety hardened but not bulletproof** (accepted M1 ceilings, marked with `ponytail:` comments in code): budget merge-on-write without a file lock; events seq re-scan on size change. Same-runId convergence between two MCP processes IS guaranteed (exclusive-create `wx`).

## Review cycle (adversarial, multi-agent)

5 Sonnet reviewers (concurrency, Windows/process, security/inputs, state machine, MCP contract) → 19 findings → 19 independent refutation-biased verifiers → **18 confirmed, 1 refuted**. All 18 fixed by 5 parallel fix agents, each fix with a regression test. Highlights: reproduced lost-update race in budget persistence; workerId path traversal (now schema-blocked); `taskkill` failure could hang verification forever (now 5s grace backstop); run-ID TOCTOU split-brain across two MCP servers (now `wx`-exclusive create); git flag injection via branch names (now `check-ref-format` + `--` separators).

## Deltas from plan

- TypeScript pinned to 5.9.x (7.0 native compiler breaks NodeNext resolution in this layout); `@types/node` pinned to Node 22.
- `worker` module has no separate RETRYING state — infra retries loop internally; logic failures are new task cards (matches doctrine, simplifies machine).
- `baseBranch` on `spawn_worker` validates against the repo's current branch rather than overriding it (supervisor has no per-call base ref in M1).
- Plugin uses `monitors/monitors.json` + polling tools; MCP `claude/channel` push skipped (research-preview gated), as planned.

## E2E smoke result

**PASSED** (`npm run smoke`, real OpenCode worker): `running → completed → verified → merged`, total cost **$0.0336**, merged sha `fcd819f…` with correct `hello.txt` on `main`. Model: `github-copilot/gpt-4.1` — the only provider authenticated in this machine's opencode (`opencode auth list`); the shipped `models.yaml` default was updated accordingly (was `anthropic/claude-sonnet-5`, which cannot run here until `opencode auth login anthropic`).

Plugin stdio entry validated end-to-end: raw JSON-RPC initialize + tools/list against `dist/mcp/bin.js` (the exact command in the plugin's `.mcp.json`) returns all 8 tools. A fully interactive `claude --plugin-dir` acceptance could not be run from this autonomous session (nested `claude -p` gets 401 — cannot reuse the interactive session's credentials) — it is the first founder checklist item below.

## Open risks / M2 inputs

1. Reviewer/verifier same-family bias (all Sonnet) — mitigated by refutation-default prompts this round; M3 introduces cross-model review as planned.
2. Cross-process budget accuracy under two simultaneous MCP servers is best-effort merge; a file lock is the upgrade path if multi-session use becomes normal.
3. `opencode run`-level quirks may still surface under long real workloads (only one real E2E so far); the verify-is-ground-truth rule contains the blast radius.
4. Plugin registration validated headlessly, not yet in the founder's interactive Claude Code session — acceptance item below.
5. MCP idle timeout (30 min) relies on the skill's polling discipline; monitors provide activity but the rule lives in prompt text.
6. Transient Windows race found by the smoke: `opencode serve` briefly holds a handle on a just-finished worker's worktree, so `finalize` cleanup (`git worktree remove`) can hit `Permission denied` moments after a successful merge. The smoke works around it (retry, then git ground truth); the core `removeWorktree`/`finalize` path should gain the same short retry in M2.

## Ledger (delegate-vs-build)

| Work | Who | Why |
|---|---|---|
| Research (OpenCode API, Claude Code mechanisms, prior art) | 3× Sonnet Explore | parallel breadth, exploration noise kept out of orchestrator context |
| Architecture design | Sonnet Plan agent + orchestrator synthesis | wide solution space; orchestrator owned final calls |
| Client interface contract | Orchestrator | architecture seam enabling wave-2 parallelism |
| Scaffold + 9 modules + plugin/smoke | 9× Sonnet implementation agents in 4 waves | disjoint file ownership; contracts per brief; orchestrator verified each wave boundary (tsc + full suite) and owned all commits |
| Review | Workflow: 5 Sonnet reviewers + 19 Sonnet verifiers | adversarial verification vs rubber-stamping |
| Fixes | 5× Sonnet, disjoint modules | scoped, regression-tested |
| Gate artifact | Orchestrator | plan-authorship tier |

## Founder acceptance checklist

- [ ] Read this gate + skim [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- [ ] `npm test` green locally (no tokens)
- [ ] Optional: `npm run smoke` (spends ~cents via opencode)
- [ ] Register plugin in a real session: `claude --plugin-dir F:\Agentic_os\packages\plugin` in any git project, then ask Claude to spawn a trivial worker
- [ ] Approve → M2 (task DAG, batch dispatch, integration branch, memory store)
