import { describe, expect, it } from "vitest";
import {
  DomainSchema,
  MAX_ORG_DEPTH,
  OrgChartSchema,
  OrgNodeSchema,
  PlanSchema,
  flattenOrg,
  validateOrgReferences,
  type OrgChart,
  type OrgNode,
  type Plan
} from "../../src/plan/schema.js";

/** Builds an OrgNode chain `depth` levels deep (iteratively, not recursively). */
function buildDeepOrgNode(depth: number): OrgNode {
  let node: OrgNode = { role: "Leaf Specialist", kind: "specialist" };
  for (let i = 0; i < depth; i++) {
    node = { role: `Level ${i}`, kind: "manager", children: [node] };
  }
  return node;
}

function planTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    title: "Do the thing",
    prompt: "Do the thing please",
    dependsOn: [],
    fileOwnership: ["src/a.ts"],
    ...overrides
  };
}

describe("PlanSchema backward compatibility", () => {
  it("accepts an M2-style plan with no domains/orgChart", () => {
    const result = PlanSchema.safeParse({
      objective: "build the thing",
      tasks: [planTask()]
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.domains).toBeUndefined();
      expect(result.data.orgChart).toBeUndefined();
    }
  });

  it("still accepts contracts alongside the omitted org fields", () => {
    const result = PlanSchema.safeParse({
      objective: "build the thing",
      tasks: [planTask()],
      contracts: [{ id: "c1", name: "Contract", description: "desc" }]
    });
    expect(result.success).toBe(true);
  });
});

describe("DomainSchema", () => {
  it("accepts a minimal domain", () => {
    const result = DomainSchema.safeParse({ id: "auth", name: "Auth" });
    expect(result.success).toBe(true);
  });

  it("accepts a domain with description and dependsOn", () => {
    const result = DomainSchema.safeParse({
      id: "billing",
      name: "Billing",
      description: "Payments and invoicing",
      dependsOn: ["auth"]
    });
    expect(result.success).toBe(true);
  });

  it("rejects a domain with a bad id", () => {
    const result = DomainSchema.safeParse({ id: "bad id!", name: "Bad" });
    expect(result.success).toBe(false);
  });
});

function buildOrgChart(): OrgChart {
  return {
    generatedFor: "ship the widget",
    root: {
      role: "CEO",
      kind: "executive",
      children: [
        {
          role: "Engineering Manager",
          kind: "manager",
          children: [
            {
              role: "Domain Lead: Auth",
              kind: "domain-lead",
              domain: "auth",
              children: [
                {
                  role: "Specialist: OAuth Engineer",
                  kind: "specialist",
                  domain: "auth",
                  specialistArchetype: "oauth-engineer"
                },
                {
                  role: "Reviewer: Security",
                  kind: "reviewer",
                  domain: "auth",
                  reviewerId: "security"
                }
              ]
            }
          ]
        },
        {
          role: "Integration Lead",
          kind: "integration"
        }
      ]
    }
  };
}

describe("OrgNodeSchema / OrgChartSchema", () => {
  it("validates a full nested org chart and round-trips through JSON", () => {
    const chart = buildOrgChart();
    const result = OrgChartSchema.safeParse(chart);
    expect(result.success).toBe(true);
    if (result.success) {
      const roundTripped = JSON.parse(JSON.stringify(result.data));
      expect(roundTripped).toEqual(chart);
    }
  });

  it("validates a plan carrying domains + orgChart together", () => {
    const plan = {
      objective: "ship the widget",
      tasks: [planTask({ domain: "auth" })],
      domains: [{ id: "auth", name: "Auth" }],
      orgChart: buildOrgChart()
    };
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("handles recursive OrgNode nesting several levels deep", () => {
    let node: OrgNode = { role: "Leaf Specialist", kind: "specialist" };
    for (let i = 0; i < 6; i++) {
      node = { role: `Level ${i}`, kind: "manager", children: [node] };
    }
    const result = OrgNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
    if (result.success) {
      let depth = 0;
      let cursor: OrgNode | undefined = result.data;
      while (cursor?.children?.length) {
        depth++;
        cursor = cursor.children[0];
      }
      expect(depth).toBe(6);
    }
  });

  it("rejects orgChart nesting deeper than MAX_ORG_DEPTH with a clean issue, not a thrown error", () => {
    const deepNode = buildDeepOrgNode(MAX_ORG_DEPTH + 5);
    let result: ReturnType<typeof OrgNodeSchema.safeParse> | undefined;
    expect(() => {
      result = OrgNodeSchema.safeParse(deepNode);
    }).not.toThrow();
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error.issues.some((i) => i.message.includes("exceeds max depth"))).toBe(true);
    }
  });

  it("does not throw a RangeError even for pathologically deep nesting", () => {
    const veryDeepNode = buildDeepOrgNode(5000);
    expect(() => OrgNodeSchema.safeParse(veryDeepNode)).not.toThrow();
    const result = OrgNodeSchema.safeParse(veryDeepNode);
    expect(result.success).toBe(false);
  });

  it("accepts nesting right at MAX_ORG_DEPTH", () => {
    const node = buildDeepOrgNode(MAX_ORG_DEPTH - 1);
    const result = OrgNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("rejects a node with an invalid kind", () => {
    const result = OrgNodeSchema.safeParse({ role: "Mystery", kind: "wizard" });
    expect(result.success).toBe(false);
  });

  it("free-form role text is expressible for any org shape", () => {
    const result = OrgNodeSchema.safeParse({
      role: "Domain Lead: Payments & Fraud",
      kind: "domain-lead",
      domain: "payments"
    });
    expect(result.success).toBe(true);
  });
});

describe("flattenOrg", () => {
  it("produces a pre-order traversal of the tree", () => {
    const chart = buildOrgChart();
    const flat = flattenOrg(chart);
    expect(flat.map((n) => n.role)).toEqual([
      "CEO",
      "Engineering Manager",
      "Domain Lead: Auth",
      "Specialist: OAuth Engineer",
      "Reviewer: Security",
      "Integration Lead"
    ]);
  });

  it("carries kind and domain through for each row", () => {
    const chart = buildOrgChart();
    const flat = flattenOrg(chart);
    const specialist = flat.find((n) => n.role === "Specialist: OAuth Engineer");
    expect(specialist).toEqual({ role: "Specialist: OAuth Engineer", kind: "specialist", domain: "auth" });
    const ceo = flat.find((n) => n.role === "CEO");
    expect(ceo).toEqual({ role: "CEO", kind: "executive" });
    expect(ceo && "domain" in ceo).toBe(false);
  });

  it("returns a single-element list for a leaf-only chart", () => {
    const chart: OrgChart = { generatedFor: "x", root: { role: "CEO", kind: "executive" } };
    expect(flattenOrg(chart)).toEqual([{ role: "CEO", kind: "executive" }]);
  });
});

describe("validateOrgReferences", () => {
  it("passes a plan whose org nodes and tasks reference declared domains", () => {
    const plan: Plan = {
      objective: "ship the widget",
      tasks: [planTask({ domain: "auth" })],
      domains: [{ id: "auth", name: "Auth" }],
      orgChart: buildOrgChart()
    };
    const result = validateOrgReferences(plan);
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("catches an org node pointing at an undefined domain", () => {
    const plan: Plan = {
      objective: "ship the widget",
      tasks: [],
      domains: [{ id: "billing", name: "Billing" }],
      orgChart: buildOrgChart()
    };
    const result = validateOrgReferences(plan);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("Domain Lead: Auth") && i.includes("auth"))).toBe(true);
  });

  it("catches a task.domain with no matching domain", () => {
    const plan: Plan = {
      objective: "ship the widget",
      tasks: [planTask({ domain: "nonexistent" })],
      domains: [{ id: "auth", name: "Auth" }]
    };
    const result = validateOrgReferences(plan);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("t1") && i.includes("nonexistent"))).toBe(true);
  });

  it("passes a plan with no domains/orgChart/task-domains at all", () => {
    const plan: Plan = {
      objective: "ship the widget",
      tasks: [planTask()]
    };
    expect(validateOrgReferences(plan)).toEqual({ valid: true, issues: [] });
  });

  it("never throws, only returns issues", () => {
    const plan: Plan = {
      objective: "ship the widget",
      tasks: [planTask({ domain: "missing" })],
      orgChart: buildOrgChart()
    };
    expect(() => validateOrgReferences(plan)).not.toThrow();
    const result = validateOrgReferences(plan);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects an orgChart nested deeper than MAX_ORG_DEPTH without throwing", () => {
    const plan: Plan = {
      objective: "ship the widget",
      tasks: [],
      domains: [],
      orgChart: { generatedFor: "x", root: buildDeepOrgNode(MAX_ORG_DEPTH + 50) }
    };
    let result: ReturnType<typeof validateOrgReferences> | undefined;
    expect(() => {
      result = validateOrgReferences(plan);
    }).not.toThrow();
    expect(result?.valid).toBe(false);
    expect(result?.issues.some((i) => i.includes("exceeds max depth"))).toBe(true);
  });

  it("still validates a normal-depth org chart as valid", () => {
    const plan: Plan = {
      objective: "ship the widget",
      tasks: [planTask({ domain: "auth" })],
      domains: [{ id: "auth", name: "Auth" }],
      orgChart: buildOrgChart()
    };
    expect(validateOrgReferences(plan)).toEqual({ valid: true, issues: [] });
  });
});
