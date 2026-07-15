import { z } from "zod";
import { PlanTaskInputSchema } from "../tasks/schema.js";

/**
 * Zod schemas for the M2 plan/batch/replan artifacts a planner (Claude, via
 * the MCP `plan_submit`/`next_batch`/`integrate_batch`/`replan_record`
 * tools) submits and the server persists under `<runDir>/`. Ids reuse the
 * same path-safety pattern the MCP layer enforces elsewhere
 * (`packages/core/src/mcp/server.ts`'s `WORKER_ID_PATTERN`/
 * `ARTIFACT_ID_PATTERN`), since these ids can end up in on-disk filenames.
 *
 * `PlanSchema` is designed for M2 (objective + tasks + contracts) with two
 * fields reserved for M3's dynamic-org work: `domains` (the areas the org is
 * organized around) and `orgChart` (the generated hierarchy — CEO -> EM ->
 * domain leads -> specialists -> reviewers -> integration, shaped
 * differently per project). Both stay optional so M2 plans that omit them
 * entirely still validate unchanged.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const idSchema = z.string().regex(ID_PATTERN, "id must match ^[A-Za-z0-9_-]{1,64}$");

/**
 * A producer/consumer interface stub between tasks. `interface` is free-form
 * stub text (e.g. a TypeScript type signature or a short prose description)
 * rather than a validated schema of its own — M2 doesn't enforce contract
 * conformance, only records the intent so a reviewer/consumer task can see
 * what was promised.
 */
export const ContractSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  interface: z.string().optional(),
  producerTaskId: z.string().optional(),
  consumerTaskIds: z.array(z.string()).optional()
});
export type Contract = z.infer<typeof ContractSchema>;

/**
 * A domain the generated org is organized around (e.g. "auth", "billing").
 * `dependsOn` records domain-to-domain ordering (other domain ids), distinct
 * from task-level `dependsOn` in `TaskCardSchema`.
 */
export const DomainSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  dependsOn: z.array(z.string()).optional()
});
export type Domain = z.infer<typeof DomainSchema>;

/**
 * The kind of role an `OrgNode` plays. `role` itself stays free-form (e.g.
 * "Domain Lead: Auth", "Specialist: OAuth Engineer") so any org shape the
 * planner generates is expressible; `kind` is the coarse bucket other code
 * (batch dispatch, reviewer wiring) switches on.
 */
export const OrgNodeKindSchema = z.enum([
  "executive",
  "manager",
  "domain-lead",
  "specialist",
  "reviewer",
  "integration"
]);
export type OrgNodeKind = z.infer<typeof OrgNodeKindSchema>;

/**
 * A node in the generated org hierarchy (CEO -> EM -> domain leads ->
 * specialists -> reviewers -> integration). This tree shape is DATA — a
 * different tree is generated per project/objective, not a fixed process.
 */
export interface OrgNode {
  role: string;
  kind: OrgNodeKind;
  /** Domain id this node is scoped to, for domain-lead/specialist nodes. */
  domain?: string;
  /** Links to a specialist archetype that will be generated for this node. */
  specialistArchetype?: string;
  /** Links to a reviewer subagent for this node. */
  reviewerId?: string;
  children?: OrgNode[];
}

/**
 * A hostile/buggy orgChart can nest `children` thousands of levels deep. A
 * real org never nests past ~8, so 20 leaves ample headroom while still
 * catching pathological input. This cap is enforced twice: once here, on
 * the raw value before zod's own recursive `z.lazy` descent gets a chance
 * to run (see `OrgNodeSchema` below), and again in `validateOrgReferences`
 * before it calls the recursive `flattenOrg` -- both are the two places a
 * deep tree would otherwise blow the call stack instead of failing cleanly.
 */
export const MAX_ORG_DEPTH = 20;

/**
 * Iterative (explicit-stack, non-recursive) max-depth of an org-node-shaped
 * value. Deliberately walks `children` with a stack rather than recursion:
 * the whole point is to measure depth *before* anything recursive touches
 * the tree, so this itself must never recurse.
 */
function orgNodeDepth(root: unknown): number {
  let maxDepth = 0;
  const stack: Array<[unknown, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (depth > maxDepth) maxDepth = depth;
    const children = (node as { children?: unknown } | null)?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        stack.push([child, depth + 1]);
      }
    }
  }
  return maxDepth;
}

// Recursive schema: `z.lazy` defers evaluation of the object shape so it can
// reference itself via `children`. The explicit `z.ZodType<OrgNode>`
// annotation is required because zod can't infer a recursive type on its
// own.
//
// Wrapped in `z.preprocess` so the iterative `orgNodeDepth` check above runs
// BEFORE zod's own recursive descent into `children`: verified empirically
// that zod's recursive parse of this shape throws an uncaught `RangeError:
// Maximum call stack size exceeded` around ~2000 levels of nesting rather
// than returning a normal `safeParse` failure. Rejecting depth > MAX_ORG_DEPTH
// up front means a pathologically deep orgChart fails as a clean, ordinary
// validation issue instead of an opaque stack overflow.
export const OrgNodeSchema: z.ZodType<OrgNode> = z.preprocess((value, ctx) => {
  const depth = orgNodeDepth(value);
  if (depth > MAX_ORG_DEPTH) {
    ctx.addIssue({
      code: "custom",
      message: `orgChart nesting exceeds max depth ${MAX_ORG_DEPTH} (found depth ${depth})`
    });
    return z.NEVER;
  }
  return value;
}, z.lazy(() =>
  z.object({
    role: z.string().min(1),
    kind: OrgNodeKindSchema,
    domain: z.string().optional(),
    specialistArchetype: z.string().optional(),
    reviewerId: z.string().optional(),
    children: z.array(OrgNodeSchema).optional()
  })
));

/**
 * The full generated org chart. `generatedFor` echoes the objective it was
 * built for, so the artifact is self-describing on disk without needing to
 * cross-reference `plan.json`.
 */
export const OrgChartSchema = z.object({
  root: OrgNodeSchema,
  generatedFor: z.string().min(1)
});
export type OrgChart = z.infer<typeof OrgChartSchema>;

export const PlanSchema = z.object({
  objective: z.string().min(1),
  tasks: z.array(PlanTaskInputSchema),
  contracts: z.array(ContractSchema).optional(),
  /** M3: the domains the org is organized around. */
  domains: z.array(DomainSchema).optional(),
  /** M3: the generated org hierarchy. */
  orgChart: OrgChartSchema.optional()
});
export type Plan = z.infer<typeof PlanSchema>;

/** A single flattened row of an `OrgChart`, as produced by `flattenOrg`. */
export interface FlatOrgNode {
  role: string;
  kind: string;
  domain?: string;
}

/**
 * Pre-order traversal of an org chart's tree into a flat list — convenient
 * for rendering (a report table) or bulk-checking nodes without recursing
 * by hand at every call site.
 */
export function flattenOrg(chart: OrgChart): FlatOrgNode[] {
  const out: FlatOrgNode[] = [];
  const visit = (node: OrgNode): void => {
    const entry: FlatOrgNode = { role: node.role, kind: node.kind };
    if (node.domain !== undefined) {
      entry.domain = node.domain;
    }
    out.push(entry);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(chart.root);
  return out;
}

/**
 * Org-consistency check for a submitted plan: every org node that names a
 * `domain` must reference a domain id actually declared in `plan.domains`,
 * and every task's `domain` (if set) must do the same. Never throws — a
 * planner/`plan_submit` caller decides what to do with `issues`.
 *
 * Checks `orgChart` nesting depth first, iteratively, before calling
 * `flattenOrg` (which recurses): a pathologically deep orgChart would blow
 * the call stack inside `flattenOrg` itself, so a too-deep chart is reported
 * as an ordinary issue and `flattenOrg` is skipped for it rather than risking
 * that recursion.
 */
export function validateOrgReferences(plan: Plan): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const domainIds = new Set((plan.domains ?? []).map((d) => d.id));

  if (plan.orgChart) {
    const depth = orgNodeDepth(plan.orgChart.root);
    if (depth > MAX_ORG_DEPTH) {
      issues.push(`orgChart nesting exceeds max depth ${MAX_ORG_DEPTH} (found depth ${depth})`);
    } else {
      for (const node of flattenOrg(plan.orgChart)) {
        if (node.domain !== undefined && !domainIds.has(node.domain)) {
          issues.push(`org node "${node.role}" references undefined domain "${node.domain}"`);
        }
      }
    }
  }

  for (const task of plan.tasks) {
    if (task.domain !== undefined && !domainIds.has(task.domain)) {
      issues.push(`task "${task.id}" references undefined domain "${task.domain}"`);
    }
  }

  return { valid: issues.length === 0, issues };
}

export const ReplanRecordSchema = z.object({
  iteration: z.number().int().positive(),
  reason: z.string().min(1),
  affectedTaskIds: z.array(z.string()),
  newTaskIds: z.array(z.string()),
  at: z.number()
});
export type ReplanRecord = z.infer<typeof ReplanRecordSchema>;

export const BatchStatusSchema = z.enum(["selected", "integrating", "integrated", "failed"]);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const BatchSchema = z.object({
  batchId: idSchema,
  taskIds: z.array(z.string()),
  createdAt: z.number(),
  status: BatchStatusSchema,
  integrationBranch: z.string().optional()
});
export type Batch = z.infer<typeof BatchSchema>;
