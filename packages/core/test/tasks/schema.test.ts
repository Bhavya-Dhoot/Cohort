import { describe, expect, it } from "vitest";
import { PlanTaskInputSchema, TaskCardSchema } from "../../src/tasks/schema.js";

function baseCard() {
  const now = Date.now();
  return {
    id: "t1",
    title: "Do the thing",
    prompt: "Do the thing please",
    status: "pending" as const,
    dependsOn: [],
    fileOwnership: ["src/a.ts"],
    createdAt: now,
    updatedAt: now
  };
}

describe("TaskCardSchema", () => {
  it("accepts a minimal valid card", () => {
    const result = TaskCardSchema.safeParse(baseCard());
    expect(result.success).toBe(true);
  });

  it("accepts optional fields when present", () => {
    const result = TaskCardSchema.safeParse({
      ...baseCard(),
      taskType: "implementation",
      contractRefs: ["contracts/1.json"],
      reviewers: ["security"],
      checkSuites: ["quick"],
      domain: "backend",
      workerId: "w1",
      meta: { batchId: "b1" }
    });
    expect(result.success).toBe(true);
  });

  it("rejects an id with disallowed characters", () => {
    const result = TaskCardSchema.safeParse({ ...baseCard(), id: "task 1/../etc" });
    expect(result.success).toBe(false);
  });

  it("rejects an id longer than 64 characters", () => {
    const result = TaskCardSchema.safeParse({ ...baseCard(), id: "a".repeat(65) });
    expect(result.success).toBe(false);
  });

  it("rejects a card missing fileOwnership", () => {
    const { fileOwnership, ...rest } = baseCard();
    const result = TaskCardSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a card missing dependsOn", () => {
    const { dependsOn, ...rest } = baseCard();
    const result = TaskCardSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = TaskCardSchema.safeParse({ ...baseCard(), status: "in-progress" });
    expect(result.success).toBe(false);
  });
});

describe("PlanTaskInputSchema", () => {
  it("accepts the planner subset without status/timestamps", () => {
    const result = PlanTaskInputSchema.safeParse({
      id: "t1",
      title: "Do the thing",
      prompt: "Do the thing please",
      dependsOn: ["t0"],
      fileOwnership: ["src/a.ts"]
    });
    expect(result.success).toBe(true);
  });

  it("rejects a planner input missing fileOwnership", () => {
    const result = PlanTaskInputSchema.safeParse({
      id: "t1",
      title: "Do the thing",
      prompt: "Do the thing please",
      dependsOn: []
    });
    expect(result.success).toBe(false);
  });

  it("rejects a planner input with a bad id", () => {
    const result = PlanTaskInputSchema.safeParse({
      id: "bad id!",
      title: "Do the thing",
      prompt: "Do the thing please",
      dependsOn: [],
      fileOwnership: []
    });
    expect(result.success).toBe(false);
  });
});
