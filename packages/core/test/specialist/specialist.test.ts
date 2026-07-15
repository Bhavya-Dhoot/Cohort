import { randomBytes } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  generateSpecialist,
  listSpecialists,
  renderAgentFile,
  retireSpecialist,
  type SpecialistSpec
} from "../../src/specialist/index.js";

const DENY_FLOOR = ["git push*", "npm publish*", "vercel deploy*"];

function makeSpec(overrides?: Partial<SpecialistSpec>): SpecialistSpec {
  return {
    agentId: "oauth-engineer",
    role: "OAuth Engineer",
    description: "Handles OAuth flows and token refresh logic.",
    systemPrompt: "You are the OAuth Engineer. Implement auth flows correctly.",
    ...overrides
  };
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/.exec(content);
  expect(match).not.toBeNull();
  return parseYaml(match![1]) as Record<string, unknown>;
}

describe("renderAgentFile", () => {
  it("puts description and mode (default subagent) in frontmatter, systemPrompt in the body", () => {
    const spec = makeSpec();
    const content = renderAgentFile(spec, []);
    const fm = parseFrontmatter(content);

    expect(fm.description).toBe(spec.description);
    expect(fm.mode).toBe("subagent");
    expect(content).toContain(spec.systemPrompt);
    expect(content.trimEnd().endsWith(spec.systemPrompt)).toBe(true);
  });

  it("honors an explicit mode and omits model/temperature/steps when unset", () => {
    const content = renderAgentFile(makeSpec({ mode: "primary" }), []);
    const fm = parseFrontmatter(content);
    expect(fm.mode).toBe("primary");
    expect(fm.model).toBeUndefined();
    expect(fm.temperature).toBeUndefined();
    expect(fm.steps).toBeUndefined();
  });

  it("includes model/temperature/steps when set", () => {
    const content = renderAgentFile(
      makeSpec({ model: "opencode/hy3-free", temperature: 0.2, steps: 12 }),
      []
    );
    const fm = parseFrontmatter(content);
    expect(fm.model).toBe("opencode/hy3-free");
    expect(fm.temperature).toBe(0.2);
    expect(fm.steps).toBe(12);
  });

  it("floor wins: denyFloor entries are deny even when spec.permission tries to allow them", () => {
    const spec = makeSpec({
      permission: {
        "git push*": "allow",
        "npm publish*": "ask",
        "read *": "allow"
      }
    });
    const content = renderAgentFile(spec, DENY_FLOOR);
    const fm = parseFrontmatter(content);
    const permission = fm.permission as Record<string, string>;

    for (const cmd of DENY_FLOOR) {
      expect(permission[cmd]).toBe("deny");
    }
    // Non-floor entries from the spec pass through untouched.
    expect(permission["read *"]).toBe("allow");
  });

  it("applies the denyFloor even when spec.permission is entirely unset", () => {
    const content = renderAgentFile(makeSpec(), DENY_FLOOR);
    const fm = parseFrontmatter(content);
    const permission = fm.permission as Record<string, string>;
    for (const cmd of DENY_FLOOR) {
      expect(permission[cmd]).toBe("deny");
    }
  });
});

describe("generateSpecialist / retireSpecialist / listSpecialists", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), `agentic-os-specialist-test-${randomBytes(6).toString("hex")}`);
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("writes the agent file at <projectDir>/.opencode/agent/<id>.md, creating dirs as needed", async () => {
    const spec = makeSpec();
    const result = await generateSpecialist({ projectDir, spec, denyFloor: DENY_FLOOR });

    const expectedPath = join(projectDir, ".opencode", "agent", "oauth-engineer.md");
    expect(result.agentId).toBe("oauth-engineer");
    expect(result.path).toBe(expectedPath);

    const stats = await stat(expectedPath);
    expect(stats.isFile()).toBe(true);

    const content = await readFile(expectedPath, "utf8");
    const fm = parseFrontmatter(content);
    expect(fm.description).toBe(spec.description);
  });

  it("rejects a duplicate agentId without overwrite", async () => {
    const spec = makeSpec();
    await generateSpecialist({ projectDir, spec, denyFloor: DENY_FLOOR });
    await expect(
      generateSpecialist({ projectDir, spec, denyFloor: DENY_FLOOR })
    ).rejects.toThrow(/already exists/);
  });

  it("overwrite: true replaces the existing file's content", async () => {
    const spec = makeSpec();
    await generateSpecialist({ projectDir, spec, denyFloor: DENY_FLOOR });

    const updatedSpec = makeSpec({ description: "Updated description." });
    await generateSpecialist({
      projectDir,
      spec: updatedSpec,
      denyFloor: DENY_FLOOR,
      overwrite: true
    });

    const list = await listSpecialists(projectDir);
    expect(list).toHaveLength(1);

    const content = await readFile(
      join(projectDir, ".opencode", "agent", "oauth-engineer.md"),
      "utf8"
    );
    const fm = parseFrontmatter(content);
    expect(fm.description).toBe("Updated description.");
  });

  it("retireSpecialist is idempotent: true then false", async () => {
    const spec = makeSpec();
    await generateSpecialist({ projectDir, spec, denyFloor: DENY_FLOOR });

    await expect(retireSpecialist({ projectDir, agentId: spec.agentId })).resolves.toEqual({
      removed: true
    });
    await expect(retireSpecialist({ projectDir, agentId: spec.agentId })).resolves.toEqual({
      removed: false
    });
  });

  it("retireSpecialist on a project with no .opencode/agent dir at all returns removed: false", async () => {
    await expect(retireSpecialist({ projectDir, agentId: "nope" })).resolves.toEqual({
      removed: false
    });
  });

  it("listSpecialists round-trips agentId/role/path for multiple generated agents", async () => {
    await generateSpecialist({ projectDir, spec: makeSpec(), denyFloor: DENY_FLOOR });
    await generateSpecialist({
      projectDir,
      spec: makeSpec({ agentId: "db-migrator", role: "Database Migrator" }),
      denyFloor: DENY_FLOOR
    });

    const list = await listSpecialists(projectDir);
    expect(list).toHaveLength(2);

    const byId = Object.fromEntries(list.map((s) => [s.agentId, s]));
    expect(byId["oauth-engineer"].role).toBe("OAuth Engineer");
    expect(byId["oauth-engineer"].path).toBe(
      join(projectDir, ".opencode", "agent", "oauth-engineer.md")
    );
    expect(byId["db-migrator"].role).toBe("Database Migrator");
  });

  it("listSpecialists on a project with no .opencode/agent dir returns []", async () => {
    await expect(listSpecialists(projectDir)).resolves.toEqual([]);
  });

  it("listSpecialists parses non-generated .md files best-effort (no role, no throw)", async () => {
    const spec = makeSpec();
    await generateSpecialist({ projectDir, spec, denyFloor: DENY_FLOOR });

    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = join(projectDir, ".opencode", "agent");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.md"), "# Just some notes, no frontmatter\n", "utf8");

    const list = await listSpecialists(projectDir);
    const byId = Object.fromEntries(list.map((s) => [s.agentId, s]));
    expect(byId.notes).toBeDefined();
    expect(byId.notes.role).toBeUndefined();
  });

  it("rejects a traversal agentId on generate", async () => {
    await expect(
      generateSpecialist({
        projectDir,
        spec: makeSpec({ agentId: "../evil" }),
        denyFloor: DENY_FLOOR
      })
    ).rejects.toThrow(/Invalid agentId/);

    // Confirms nothing escaped .opencode/agent: the traversal target must not exist.
    await expect(stat(join(projectDir, "..", "evil.md"))).rejects.toThrow();
  });

  it("rejects an absolute-path agentId on generate", async () => {
    await expect(
      generateSpecialist({
        projectDir,
        spec: makeSpec({ agentId: "/etc/passwd" }),
        denyFloor: DENY_FLOOR
      })
    ).rejects.toThrow(/Invalid agentId/);
  });

  it("rejects a traversal agentId on retire", async () => {
    await expect(
      retireSpecialist({ projectDir, agentId: "../evil" })
    ).rejects.toThrow(/Invalid agentId/);
  });

  it("rejects an absolute-path agentId on retire", async () => {
    await expect(
      retireSpecialist({ projectDir, agentId: "C:\\evil" })
    ).rejects.toThrow(/Invalid agentId/);
  });

  it("never writes outside .opencode/agent for a valid agentId", async () => {
    const spec = makeSpec({ agentId: "safe-agent" });
    await generateSpecialist({ projectDir, spec, denyFloor: DENY_FLOOR });

    const list = await listSpecialists(projectDir);
    for (const s of list) {
      expect(s.path.startsWith(join(projectDir, ".opencode", "agent"))).toBe(true);
    }
  });
});
