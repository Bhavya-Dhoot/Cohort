#!/usr/bin/env node
/**
 * Bundles the assets `cohort init` scaffolds into a target project —
 * config/*.yaml defaults and the plugin's skill + reviewer agents — into
 * packages/cli/vendor/, so the published `cohort` npm package is
 * self-contained (works from a global install with no dev checkout).
 * Source of truth stays at the repo root (config/) and packages/plugin
 * (skills/, agents/); this only mirrors them at build/pack time. Runs via
 * this package's own `build` script and automatically before
 * `npm pack`/`npm publish` (`prepack`).
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const repoRoot = join(cliRoot, "..", "..");
const vendorDir = join(cliRoot, "vendor");

const copies = [
  [join(repoRoot, "config"), join(vendorDir, "config")],
  [join(repoRoot, "packages", "plugin", "skills"), join(vendorDir, "skills")],
  [join(repoRoot, "packages", "plugin", "agents"), join(vendorDir, "agents")]
];

await rm(vendorDir, { recursive: true, force: true });
for (const [src, dest] of copies) {
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`[copy-assets] ${src} -> ${dest}`);
}
