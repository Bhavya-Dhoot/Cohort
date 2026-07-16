# Reviewer subagents

Dedicated Claude Code subagent definitions for the review step in
`skills/cohort/SKILL.md` section 4a. Each file is one reviewer:
`security.md`, `performance.md`, `architecture.md`, `testing.md`,
`style.md`, `documentation.md`, `accessibility.md`.

**Read-only guarantee:** every reviewer's frontmatter declares
`tools: Read, Grep, Glob, mcp__cohort__review_verdict` — read access to
the codebase plus the one MCP tool needed to write a verdict, and nothing
else: no `Edit`, `Write`, `NotebookEdit`, or `Bash`. This is enforced by the
tool allowlist itself, not by prompt convention: a reviewer structurally
cannot change a worker's diff, only inspect it (`Read`/`Grep`/`Glob`) and
record a verdict via `review_verdict` (`pass` / `revise` / `block` with
file-anchored `findings`). Reviewers never write production code — the
allowlist gives them no tool capable of it.

**Extension point:** adding a reviewer discipline means adding one file here
— `<reviewerId>.md`, frontmatter `name` matching the id
(`^[a-z][a-z0-9-]{0,40}$`, see `packages/core/src/review/schema.ts`), a
`description` stating what it checks and when to dispatch it, and a
discipline-specific review prompt. No core code changes required.

The orchestration skill selects which reviewers to dispatch per task from
this set — not every task needs every reviewer (e.g. `accessibility` only
applies to UI-touching diffs; skip it for a backend-only change).
