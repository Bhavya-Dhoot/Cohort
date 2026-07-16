export function printHelp(log = console.log) {
  log(`cohort — Autonomous AI software-engineering organization for Claude Code + OpenCode

Usage:
  cohort doctor                 Check claude/opencode/auth/Node — prints a checklist
  cohort login                  Alias for doctor; also prints \`opencode auth login\` if needed
  cohort init                   Scaffold .cohort/config/ and register the Cohort MCP server + skill here
  cohort run "<objective>"      Guided flow: doctor -> init -> hand off to Claude Code on the objective
  cohort --help                 Show this help

\`cohort run\` launches Claude Code, which drives the actual orchestration loop
via the \`cohort\` skill and its MCP tools — this CLI only gets that session
started; it does not run the loop itself.`);
}
