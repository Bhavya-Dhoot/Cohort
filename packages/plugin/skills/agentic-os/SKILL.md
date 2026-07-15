---
name: agentic-os
description: Manage parallel OpenCode implementation workers spawned into isolated git worktrees via the agentic-os MCP tools (spawn_worker, worker_status, stream_worker_log, collect_worker, verify_worker, finalize_worker, abort_worker, list_workers). Use this whenever the user asks to implement, build, or fix something by delegating to background coding agents, or whenever multiple independent implementation tasks need to run concurrently instead of one at a time in-session. Always use it to poll, verify, and merge workers you've already spawned.
---

# Agentic OS: OpenCode worker orchestration

You are the CEO/planner/reviewer. You never write implementation code
yourself for tasks handed to workers — you spawn OpenCode workers to do
that, then verify their work independently before trusting it. Follow this
loop for every worker.

## 1. Spawn with a self-contained task card

The worker starts blind: no memory of this conversation, no access to your
reasoning. Write the `prompt` as a complete task card:
- What file(s)/area to touch, and what NOT to touch (file-ownership scope).
- The concrete acceptance criteria — what "done" looks like.
- Explicit constraints (don't commit, don't run tests, don't touch X).

Call `spawn_worker(taskId, prompt, taskType?, model?, agentId?)`. Omit
`model` to use config-driven routing (`taskType` -> `models.yaml`); only
pass `model` explicitly when you need to force a specific one (e.g. after a
budget downgrade). One worker per task card. Never give two concurrently
running workers overlapping file ownership — that's a structural conflict,
not something to catch after the fact.

Models default to the best available free-tier option automatically:
`models.yaml`'s shipped routing resolves to `auto:free`, which picks the
newest zero-cost, tool-call-capable model from a provider actually usable on
this machine, re-checked against the live catalog on every MCP server
start — so it's never a stale hardcoded name. Only pass `model` or a
`taskType` pointing at a pinned route when the human explicitly asks for a
specific model.

## 2. Poll — never let 30 minutes pass silently

Poll `worker_status(workerId)` roughly every 1–5 minutes while a worker
runs. This is not optional pacing advice: the MCP session has an idle
timeout, and 30 minutes with no tool call risks losing track of an
in-flight worker. If you have several workers running, `worker_status()`
with no `workerId` polls all of them in one call — prefer that over N
separate polls.

When a status looks surprising (stuck in `running` far past what the task
should take, or a state you didn't expect), read `stream_worker_log(workerId,
sinceSeq)` to see what's actually happening before deciding anything.

## 3. Collect and verify — never trust the worker's self-report

When a worker reaches `completed`, call `collect_worker(workerId)` to see
what it actually changed (files, diffstat). Then call
`verify_worker(workerId, command)` with the **project's real test/build
command** — not a trivial placeholder, not the worker's own claim of
success. A worker reporting "done, tests pass" is a hint, never truth; only
a real command run against the real worktree diff counts. `verify_worker`
moves the worker to `verified` or `verification_failed` based on the actual
exit code.

## 4. Finalize

- `verified` -> `finalize_worker(workerId, "merge")`. If the result comes
  back `merged: false` with `conflictFiles`, that is a decision point, not
  an error: either spawn a fix-up worker scoped to just those files, or
  escalate to the human if the conflict implies a real design clash.
- `failed` / `timeout` / `orphaned` -> `collect_worker` first to see what
  happened, then `finalize_worker(workerId, "discard")`. If the task still
  needs doing, spawn a **new** task card with a revised prompt — never
  resubmit the identical prompt verbatim; whatever caused the failure will
  most likely cause it again.

**Rule: never merge unverified work.** `finalize_worker("merge")` requires
`verified` state — there is no path around `verify_worker`.

## 5. Budget tiers

Check the `budget` object returned by `worker_status`/`spawn_worker`:
- `ok` — spawn normally.
- `soft` — prefer cheaper/smaller models on your next spawns (the
  configured `small_model` downgrade); don't halt existing work.
- `hard` — stop spawning new workers entirely and tell the human before
  doing anything else. A refused `spawn_worker` call at this tier is
  expected behavior, not a bug to retry around.

## 6. Cleanup

Use `abort_worker(workerId, reason)` to stop a worker that's clearly
off-track before it burns more budget. Always record a real reason — it
goes into the run's audit trail.
