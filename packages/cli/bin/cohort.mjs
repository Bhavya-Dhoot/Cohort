#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDoctor, runLogin } from "../src/doctor.mjs";
import { runInit } from "../src/init.mjs";
import { runRun } from "../src/run.mjs";
import { printHelp } from "../src/help.mjs";

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: false,
      options: {
        help: { type: "boolean", short: "h" }
      }
    });
  } catch (err) {
    console.error(`cohort: ${err.message}`);
    return 1;
  }

  const [command, ...rest] = parsed.positionals;

  if (command === undefined || command === "help" || parsed.values.help) {
    printHelp();
    return 0;
  }

  switch (command) {
    case "doctor":
      return (await runDoctor()).ok ? 0 : 1;
    case "login":
      return (await runLogin()).ok ? 0 : 1;
    case "init":
      return (await runInit()).ok ? 0 : 1;
    case "run":
      return (await runRun(rest)).ok ? 0 : 1;
    default:
      console.error(`cohort: unknown command '${command}'\n`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`cohort: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  });
