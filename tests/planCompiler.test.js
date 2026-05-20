import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compilePlan } from "../src/planCompiler.js";
import { ButlerService } from "../src/butlerService.js";

test("compiler creates an ordered implementation plan from a natural-language goal", () => {
  const plan = compilePlan({
    objective: "Build a CLI dashboard and tests",
    projectRoot: "/repo"
  });
  assert.deepEqual(plan.tasks.map((task) => task.role), [
    "iteration-worker",
    "review-worker",
    "verifier",
    "promoter"
  ]);
  assert.deepEqual(plan.tasks[1].prerequisites, [plan.tasks[0].id]);
  assert.deepEqual(plan.tasks[2].verificationCommand, ["npm", "test"]);
  assert.equal(plan.tasks[1].targetPlanItemId, plan.tasks[0].id);
  assert.equal(plan.tasks[3].targetPlanItemId, plan.tasks[0].id);
});

test("compiler keeps review-only goals out of implementation roles", () => {
  const plan = compilePlan({
    objective: "Deep review the whole product for release risks",
    projectRoot: "/repo"
  });
  assert.deepEqual(plan.tasks.map((task) => task.role), ["review-worker", "verifier"]);
});

test("service persists compiled plan tasks under one goal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-plan-"));
  const service = new ButlerService({ projectRoot: dir });
  const result = await service.planGoal({ objective: "Add a release runbook" });

  assert.equal(result.goal.state, "planned");
  assert.equal(result.tasks.length, 4);
  assert.equal(result.tasks[0].goalId, result.goal.id);
  assert.equal(result.tasks[0].planItemId, result.plan.tasks[0].id);
  assert.equal(result.tasks[1].targetTaskId, result.tasks[0].id);
  assert.equal(result.tasks[3].targetTaskId, result.tasks[0].id);
});
