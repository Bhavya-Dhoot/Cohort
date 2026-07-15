import { describe, expect, it, vi } from "vitest";
import { NoFreeModelError, resolveFreeModel } from "../../src/model-catalog/index.js";
import type { FetchFn } from "../../src/opencode-client/http.js";

/**
 * Shape mirrors the REAL `GET /provider` response (opencode 1.15.13, live
 * `opencode serve` on this machine, see `opencode-client/docs-notes.md`
 * "Model catalog / free-model discovery"): `{ all: Provider[], default:
 * Record<providerId, modelId>, connected: string[] }`, each `Provider.models`
 * a map of `modelId -> Model` carrying `cost.{input,output}`,
 * `capabilities.toolcall`, `limit.context`, and `release_date`. Field values
 * below are trimmed/renamed but the structure and a subset of real ids
 * (`opencode/hy3-free`, `opencode/big-pickle`, `github-copilot/claude-sonnet-5`)
 * are taken directly from that live response.
 */
const REAL_SHAPED_CATALOG = {
  all: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      models: {
        "hy3-free": {
          id: "hy3-free",
          providerID: "opencode",
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 190000, input: 160000, output: 32000 },
          release_date: "2026-06-26",
          status: "active"
        },
        "big-pickle": {
          id: "big-pickle",
          providerID: "opencode",
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, input: 160000, output: 32000 },
          release_date: "2025-10-17",
          status: "active"
        },
        "silent-narrator": {
          id: "silent-narrator",
          providerID: "opencode",
          // Free but cannot call tools -- must be excluded regardless of price.
          capabilities: { toolcall: false },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 100000 },
          release_date: "2026-07-01",
          status: "active"
        }
      }
    },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      models: {
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          providerID: "github-copilot",
          capabilities: { toolcall: true },
          // Nonzero nominal cost -- billed within the Copilot subscription,
          // but the catalog itself reports it as non-free, so it's excluded.
          cost: { input: 2, output: 10, cache: { read: 0, write: 0 } },
          limit: { context: 200000 },
          release_date: "2026-06-30",
          status: "active"
        }
      }
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-haiku": {
          id: "claude-haiku",
          providerID: "anthropic",
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000 },
          release_date: "2026-01-01",
          status: "active"
        }
      }
    }
  ],
  default: { opencode: "big-pickle", "github-copilot": "claude-sonnet-4.6", anthropic: "claude-haiku" },
  // Only opencode and github-copilot are usable on this machine; anthropic
  // is in the models.dev catalog but not authenticated/keyless here.
  connected: ["github-copilot", "opencode"]
};

function fakeFetch(payload: unknown, status = 200): FetchFn {
  return vi.fn(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    } as Response;
  }) as unknown as FetchFn;
}

describe("resolveFreeModel", () => {
  it("requests {baseUrl}/provider", async () => {
    const fetchFn = fakeFetch(REAL_SHAPED_CATALOG);
    await resolveFreeModel("http://127.0.0.1:4096", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:4096/provider",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("picks the newest free, tool-call-capable, connected model", async () => {
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(REAL_SHAPED_CATALOG));
    expect(result.model).toBe("opencode/hy3-free");
  });

  it("excludes paid models even from a connected, otherwise-qualifying provider", async () => {
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(REAL_SHAPED_CATALOG));
    expect(result.candidates.some((c) => c.provider === "github-copilot")).toBe(false);
  });

  it("excludes free models that don't support tool-calling", async () => {
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(REAL_SHAPED_CATALOG));
    expect(result.candidates.some((c) => c.model === "silent-narrator")).toBe(false);
  });

  it("excludes free, tool-call-capable models from an unconnected/unusable provider", async () => {
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(REAL_SHAPED_CATALOG));
    expect(result.candidates.some((c) => c.provider === "anthropic")).toBe(false);
  });

  it("returns every qualifying candidate, ranked winner first", async () => {
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(REAL_SHAPED_CATALOG));
    expect(result.candidates.map((c) => `${c.provider}/${c.model}`)).toEqual([
      "opencode/hy3-free",
      "opencode/big-pickle"
    ]);
  });

  it("ranks by newest release_date first, regardless of context size", async () => {
    const catalog = {
      all: [
        {
          id: "opencode",
          models: {
            newer: {
              id: "newer",
              providerID: "opencode",
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
              limit: { context: 10000 },
              release_date: "2026-06-01"
            },
            older: {
              id: "older",
              providerID: "opencode",
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
              limit: { context: 1000000 },
              release_date: "2026-01-01"
            }
          }
        }
      ],
      default: {},
      connected: ["opencode"]
    };
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(catalog));
    expect(result.model).toBe("opencode/newer");
  });

  it("tie-breaks equal release_date by larger context limit", async () => {
    const catalog = {
      all: [
        {
          id: "opencode",
          models: {
            small: {
              id: "small",
              providerID: "opencode",
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
              limit: { context: 50000 },
              release_date: "2026-06-01"
            },
            big: {
              id: "big",
              providerID: "opencode",
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
              limit: { context: 1000000 },
              release_date: "2026-06-01"
            }
          }
        }
      ],
      default: {},
      connected: ["opencode"]
    };
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(catalog));
    expect(result.model).toBe("opencode/big");
  });

  it("treats a missing cost object as free (documented-free, not just zero)", async () => {
    const catalog = {
      all: [
        {
          id: "opencode",
          models: {
            "no-cost-field": {
              id: "no-cost-field",
              providerID: "opencode",
              capabilities: { toolcall: true },
              limit: { context: 50000 },
              release_date: "2026-06-01"
            }
          }
        }
      ],
      default: {},
      connected: ["opencode"]
    };
    const result = await resolveFreeModel("http://127.0.0.1:4096", fakeFetch(catalog));
    expect(result.model).toBe("opencode/no-cost-field");
  });

  it("throws NoFreeModelError with a per-provider breakdown when nothing qualifies", async () => {
    const catalog = {
      all: [
        {
          id: "github-copilot",
          models: {
            "claude-sonnet-5": {
              id: "claude-sonnet-5",
              providerID: "github-copilot",
              capabilities: { toolcall: true },
              cost: { input: 2, output: 10 },
              limit: { context: 200000 },
              release_date: "2026-06-30"
            }
          }
        },
        {
          id: "anthropic",
          models: {
            "claude-haiku": {
              id: "claude-haiku",
              providerID: "anthropic",
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
              limit: { context: 200000 },
              release_date: "2026-01-01"
            }
          }
        }
      ],
      default: {},
      // Only github-copilot connected, and its only model is paid.
      connected: ["github-copilot"]
    };

    await expect(resolveFreeModel("http://127.0.0.1:4096", fakeFetch(catalog))).rejects.toThrow(NoFreeModelError);
    await expect(resolveFreeModel("http://127.0.0.1:4096", fakeFetch(catalog))).rejects.toThrow(/github-copilot/);
    await expect(resolveFreeModel("http://127.0.0.1:4096", fakeFetch(catalog))).rejects.toThrow(/anthropic/);
  });
});
