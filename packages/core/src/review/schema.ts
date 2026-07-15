import { z } from "zod";

/**
 * Zod schemas for reviewer verdicts (`review/index.ts`'s `ReviewStore`).
 * This module never runs an LLM and never judges anything itself -- the
 * judgment is produced by Claude reviewer subagents elsewhere (read-only,
 * `Read/Grep/Glob` tools only, per docs/ARCHITECTURE.md); this schema only
 * shapes and validates what they hand back for storage.
 *
 * `taskId` reuses the `TaskCard` id pattern (`tasks/schema.ts`'s
 * `TASK_ID_PATTERN`) for consistency, since a verdict always references an
 * existing task card. `reviewerId` (e.g. "security", "architecture") uses
 * its own lowercase-only pattern -- it becomes a filename prefix on disk
 * (`review/index.ts`), and mirrors the same shape `memory/index.ts` uses for
 * its section names for the same reason.
 *
 * Anti-rubber-stamp rule (plan.md "Risk 2: reviewer rubber-stamping"): a
 * `revise` or `block` verdict is only trustworthy if it points at *something
 * concrete*. The `superRefine` below rejects any non-`pass` verdict with zero
 * findings at the schema layer, so this is enforced no matter which reviewer
 * subagent or code path produces the verdict -- it cannot be bypassed by a
 * lazy prompt. A `pass` verdict may legitimately have zero findings (nothing
 * wrong to cite).
 */

export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REVIEWER_ID_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

const taskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, "taskId must match ^[A-Za-z0-9_-]{1,64}$");
const reviewerIdSchema = z
  .string()
  .regex(REVIEWER_ID_PATTERN, "reviewerId must match ^[a-z][a-z0-9-]{0,40}$");

export const ReviewSeveritySchema = z.enum(["critical", "major", "minor", "nit"]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewFindingSchema = z.object({
  severity: ReviewSeveritySchema,
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  // `.trim()` before `.min(8)` so whitespace-only notes (" ") and
  // single-char throwaways ("x", ".") can't satisfy the anti-rubber-stamp
  // rule below just by being non-empty. 8 trimmed characters rejects those
  // while still admitting a legitimately terse real note (e.g. "SQL
  // injection", 13 chars).
  note: z.string().trim().min(8, "note must contain at least 8 characters of real content")
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewVerdictOutcomeSchema = z.enum(["pass", "revise", "block"]);
export type ReviewVerdictOutcome = z.infer<typeof ReviewVerdictOutcomeSchema>;

/** Fields common to both the caller-supplied input and the fully-stamped stored shape. */
const ReviewVerdictBaseSchema = z.object({
  taskId: taskIdSchema,
  reviewerId: reviewerIdSchema,
  verdict: ReviewVerdictOutcomeSchema,
  findings: z.array(ReviewFindingSchema),
  summary: z.string().optional()
});

/**
 * Rejects a `revise`/`block` verdict that cites no findings. Applied to both
 * schemas below via `superRefine` so the rule holds whether or not `at` has
 * been stamped yet.
 */
function requireFindingsForNonPass(
  data: { verdict: ReviewVerdictOutcome; findings: ReviewFinding[] },
  ctx: z.RefinementCtx
): void {
  if (data.verdict !== "pass" && data.findings.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["findings"],
      message: "a non-pass verdict must cite at least one finding"
    });
  }
}

/**
 * The subset `recordVerdict` accepts from a caller: `at` is optional since
 * the store stamps it when absent (mirrors `TaskCard`/`PlanTaskInputSchema`'s
 * split in `tasks/schema.ts`).
 */
export const ReviewVerdictInputSchema = ReviewVerdictBaseSchema.extend({
  at: z.number().optional()
}).superRefine(requireFindingsForNonPass);
export type ReviewVerdictInput = z.infer<typeof ReviewVerdictInputSchema>;

/** The full persisted shape, `at` required. */
export const ReviewVerdictSchema = ReviewVerdictBaseSchema.extend({
  at: z.number()
}).superRefine(requireFindingsForNonPass);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
