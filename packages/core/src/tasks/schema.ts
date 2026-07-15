import { z } from "zod";

/**
 * Zod schemas for the M2 DAG-aware task card. `TaskCardSchema` is the full
 * persisted shape (status + timestamps included); `PlanTaskInputSchema` is
 * the narrower subset a planner supplies before the store fills in
 * status/createdAt/updatedAt. Ids reuse the same path-safety pattern the
 * MCP layer enforces for `workerId` (`packages/core/src/mcp/server.ts`),
 * since task ids can end up in on-disk paths too.
 */

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Named `TaskCardStatus`, not `TaskStatus` -- `tasks/index.ts` already
// exports a `TaskStatus` type for the M1 flat `TaskRecord`, and barrel
// re-exports (`export * from "./schema.js"`) would otherwise collide.
export const TaskCardStatusSchema = z.enum([
  "pending",
  "assigned",
  "running",
  "done",
  "failed",
  "blocked"
]);
export type TaskCardStatus = z.infer<typeof TaskCardStatusSchema>;

const taskIdSchema = z.string().regex(TASK_ID_PATTERN, "id must match ^[A-Za-z0-9_-]{1,64}$");

export const TaskCardSchema = z.object({
  id: taskIdSchema,
  title: z.string(),
  prompt: z.string(),
  status: TaskCardStatusSchema,
  /** Task ids this task waits on; must all reach `done` before it's ready. */
  dependsOn: z.array(z.string()),
  /** POSIX-style forward-slash path globs this task exclusively writes to. */
  fileOwnership: z.array(z.string()),
  taskType: z.string().optional(),
  contractRefs: z.array(z.string()).optional(),
  reviewers: z.array(z.string()).optional(),
  checkSuites: z.array(z.string()).optional(),
  domain: z.string().optional(),
  workerId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  meta: z.record(z.string(), z.unknown()).optional()
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

/**
 * The subset of `TaskCard` a planner supplies. `status`/`createdAt`/
 * `updatedAt` are filled in by the store on `put`, not by the planner.
 */
export const PlanTaskInputSchema = z.object({
  id: taskIdSchema,
  title: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()),
  fileOwnership: z.array(z.string()),
  taskType: z.string().optional(),
  contractRefs: z.array(z.string()).optional(),
  reviewers: z.array(z.string()).optional(),
  checkSuites: z.array(z.string()).optional(),
  domain: z.string().optional()
});
export type PlanTaskInput = z.infer<typeof PlanTaskInputSchema>;
