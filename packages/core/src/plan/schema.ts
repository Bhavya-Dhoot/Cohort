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
 * fields reserved, not yet acted on, for M3's dynamic-org work: `domains`
 * (a flat list of domain names) and `orgChart` (an intentionally unvalidated
 * passthrough — M3 owns its shape; M2 only needs to round-trip it to disk).
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

export const PlanSchema = z.object({
  objective: z.string().min(1),
  tasks: z.array(PlanTaskInputSchema),
  contracts: z.array(ContractSchema).optional(),
  /** M3: flat list of domain names the org will be organized around. */
  domains: z.array(z.string()).optional(),
  /** M3: dynamic org-chart payload; passthrough, unvalidated at this layer. */
  orgChart: z.unknown().optional()
});
export type Plan = z.infer<typeof PlanSchema>;

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
