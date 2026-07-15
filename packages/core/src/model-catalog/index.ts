/**
 * Resolves the `auto:free` model-routing sentinel (see `config/models.yaml`
 * and `mcp/server.ts`'s `spawn_worker` handler) to a concrete `"provider/
 * model"` string by querying the live OpenCode catalog — never a hardcoded
 * model name, so the choice tracks whatever the catalog says *right now*
 * instead of going stale as new free models ship or old ones are retired.
 *
 * Discovery (`opencode-client/docs-notes.md`, "Model catalog / free-model
 * discovery"): `GET {baseUrl}/provider` returns
 * `{ all: Provider[], default: Record<providerId, modelId>, connected:
 * string[] }`. Each `Provider.models` is a map of `modelId -> Model`, where
 * `Model.cost` carries `{input, output, cache}` in USD per million tokens
 * (opencode sources this from models.dev), `Model.capabilities.toolcall` is
 * a boolean, `Model.release_date` is an ISO date string (`YYYY-MM-DD`), and
 * `Model.limit.context` is the context-window size in tokens. `connected`
 * lists provider ids OpenCode can actually reach on *this* machine right
 * now — authenticated (e.g. `github-copilot` via `opencode auth login`) or
 * keyless (e.g. the built-in `opencode` Zen gateway) — which is exactly
 * "usable" for this module's purposes; every other provider in `all` exists
 * in the models.dev catalog but is not currently reachable here.
 *
 * Filter (a model qualifies as "free" only if every condition holds):
 *   1. `cost.input === 0 && cost.output === 0` (a missing `cost.input`/
 *      `cost.output` is also treated as `0` — some catalog entries document
 *      a model as free by omitting the field rather than writing an
 *      explicit `0`).
 *   2. `capabilities.toolcall === true` — spawned workers drive OpenCode's
 *      tool-calling loop (file edits, shell commands); a model that can't
 *      call tools can't do the job regardless of price.
 *   3. `providerID` is present in the catalog's `connected` list.
 *
 * Ranking (deterministic — no tie is left to catalog array order):
 *   1. Newest `release_date` first (ISO `YYYY-MM-DD` strings sort
 *      correctly with plain string comparison).
 *   2. Tie-break: larger `limit.context`.
 *   3. Still tied: `provider/model` alphabetically, purely for determinism.
 *
 * When nothing qualifies, `resolveFreeModel` throws `NoFreeModelError` with
 * a message grouping *why* each provider was excluded (not connected here,
 * vs. connected but none of its models are free+tool-call-capable) rather
 * than a bare "no free model" — the founder needs to know what auth would
 * unlock a free model, not just that resolution failed.
 */

import { fetchJson, type FetchFn } from "../opencode-client/http.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Providers this deep into the "not connected" list are summarized, not enumerated one-by-one. */
const MAX_UNCONNECTED_IDS_LISTED = 15;

export interface FreeModelCandidate {
  provider: string;
  model: string;
  releaseDate: string;
  contextLimit: number;
}

export interface ResolveFreeModelResult {
  /** `"provider/model"` — the top-ranked candidate. */
  model: string;
  /** Every qualifying free + tool-call-capable + connected model, ranked winner first. */
  candidates: FreeModelCandidate[];
}

export class NoFreeModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoFreeModelError";
  }
}

interface UpstreamModel {
  id: string;
  providerID: string;
  capabilities?: { toolcall?: boolean };
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  release_date?: string;
}

interface UpstreamProvider {
  id: string;
  models: Record<string, UpstreamModel>;
}

interface UpstreamProviderList {
  all: UpstreamProvider[];
  connected: string[];
}

function isFreeToolCallModel(model: UpstreamModel): boolean {
  const input = model.cost?.input ?? 0;
  const output = model.cost?.output ?? 0;
  return input === 0 && output === 0 && model.capabilities?.toolcall === true;
}

/** ISO `YYYY-MM-DD` strings compare correctly lexicographically; a missing date sorts last (oldest). */
function releaseDateOf(model: UpstreamModel): string {
  return model.release_date ?? "";
}

function compareCandidates(a: FreeModelCandidate, b: FreeModelCandidate): number {
  if (a.releaseDate !== b.releaseDate) {
    return a.releaseDate > b.releaseDate ? -1 : 1;
  }
  if (a.contextLimit !== b.contextLimit) {
    return b.contextLimit - a.contextLimit;
  }
  const aKey = `${a.provider}/${a.model}`;
  const bKey = `${b.provider}/${b.model}`;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function truncatedList(ids: string[]): string {
  if (ids.length <= MAX_UNCONNECTED_IDS_LISTED) {
    return ids.join(", ");
  }
  const shown = ids.slice(0, MAX_UNCONNECTED_IDS_LISTED);
  return `${shown.join(", ")}, and ${ids.length - shown.length} more`;
}

function buildExclusionReport(catalog: UpstreamProviderList): string {
  const connected = new Set(catalog.connected);
  const connectedProviders = catalog.all.filter((p) => connected.has(p.id));
  const unconnectedIds = catalog.all.filter((p) => !connected.has(p.id)).map((p) => p.id);

  const lines: string[] = [];
  if (connectedProviders.length === 0) {
    lines.push("No provider is connected on this machine (see `opencode auth list`).");
  } else {
    for (const provider of connectedProviders) {
      const modelIds = Object.keys(provider.models);
      lines.push(
        `  - '${provider.id}': ${modelIds.length} model(s) connected, none satisfy ` +
          `cost.input===0 && cost.output===0 && capabilities.toolcall===true`
      );
    }
  }
  if (unconnectedIds.length > 0) {
    lines.push(
      `  - ${unconnectedIds.length} other provider(s) in the catalog are not connected on this machine ` +
        `(not authenticated and no keyless access) and were skipped entirely: ${truncatedList(unconnectedIds)}`
    );
  }
  return lines.join("\n");
}

/**
 * Fetches `{baseUrl}/provider` and resolves the best currently-usable free
 * model. Throws `NoFreeModelError` (never returns an empty `candidates`
 * list as a success) when nothing qualifies — see the module docstring for
 * the filter/ranking rules and the "usable" definition.
 */
export async function resolveFreeModel(
  baseUrl: string,
  fetchFn: FetchFn = fetch
): Promise<ResolveFreeModelResult> {
  const catalog = await fetchJson<UpstreamProviderList>(
    fetchFn,
    `${baseUrl}/provider`,
    { method: "GET" },
    DEFAULT_TIMEOUT_MS
  );

  const connected = new Set(catalog.connected);
  const candidates: FreeModelCandidate[] = [];

  for (const provider of catalog.all) {
    if (!connected.has(provider.id)) continue;
    for (const model of Object.values(provider.models)) {
      if (!isFreeToolCallModel(model)) continue;
      candidates.push({
        provider: provider.id,
        model: model.id,
        releaseDate: releaseDateOf(model),
        contextLimit: model.limit?.context ?? 0
      });
    }
  }

  if (candidates.length === 0) {
    throw new NoFreeModelError(
      `No free (catalog cost.input===0 && cost.output===0), tool-call-capable, currently-usable model ` +
        `found via ${baseUrl}/provider. Breakdown by provider:\n${buildExclusionReport(catalog)}`
    );
  }

  candidates.sort(compareCandidates);
  const winner = candidates[0]!;
  return { model: `${winner.provider}/${winner.model}`, candidates };
}
