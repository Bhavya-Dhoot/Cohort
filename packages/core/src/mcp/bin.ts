/**
 * Entry point for the Cohort MCP stdio server, invoked as `node bin.js`
 * by a Claude Code plugin's `.mcp.json` (no shebang needed — it's never
 * executed directly). Thin by design: resolve config from env/cwd, build
 * the server, connect stdio, keep the process alive until SIGINT/SIGTERM.
 *
 * Never writes to stdout — that's the protocol channel the MCP client reads
 * JSON-RPC from `StdioServerTransport` on. All diagnostics go to stderr.
 *
 * Dist layout note: this file compiles 1:1 to `packages/core/dist/mcp/bin.js`
 * (`tsconfig.json`'s rootDir=src/outDir=dist mirrors `src/mcp/bin.ts`), so
 * the repo-root `config/` directory — the shipped defaults — is four
 * directories up from this file's own directory at runtime:
 *   dist/mcp -> dist -> packages/core -> packages -> <repo root>/config
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgenticMcpServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRootConfigDir = join(here, "..", "..", "..", "..", "config");

const projectDir = process.env.AGENTIC_PROJECT_DIR ?? process.cwd();
const platformConfigDir = process.env.AGENTIC_CONFIG_DIR ?? repoRootConfigDir;

async function main(): Promise<void> {
  const { server, close } = await createAgenticMcpServer({ projectDir, platformConfigDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[cohort-mcp] received ${signal}, shutting down\n`);
    close()
      .catch((err: unknown) => {
        process.stderr.write(`[cohort-mcp] error during shutdown: ${errMessage(err)}\n`);
      })
      .finally(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

main().catch((err: unknown) => {
  process.stderr.write(`[cohort-mcp] fatal: ${errMessage(err)}\n`);
  process.exit(1);
});
