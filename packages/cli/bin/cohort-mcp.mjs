#!/usr/bin/env node
// Thin executable wrapper so an installed `cohort` package exposes a
// `cohort-mcp` bin that a project's .mcp.json can launch directly. npm's
// bin shims need a shebang to be exec'd by the OS on POSIX; @cohort/core's
// dist/mcp/bin.js intentionally has none (its doc comment: "no shebang
// needed — it's never executed directly" — true in the dev-checkout flow,
// where .mcp.json invokes it via `node <path>`). Rather than add a shebang
// inside packages/core/src (out of this package's ownership), this wrapper
// — which packages/cli does own — just imports it for its side effects.
import "@cohort/core/mcp/bin.js";
