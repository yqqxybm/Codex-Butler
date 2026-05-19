import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkOrder, validateWorkerResult, WORKER_OUTPUT_SCHEMA } from "../src/roleContracts.js";

test("iteration worker work order carries the required skill and forbidden actions", () => {
  const order = buildWorkOrder({
    role: "iteration-worker",
    taskId: "t1",
    goal: "g1",
    objective: "Change code in a task worktree",
    ownedScope: "worktrees/t1"
  });
  assert.equal(order.requiredSkill, "project-iteration");
  assert.ok(order.forbidden.includes("edit_main_workspace"));
  assert.equal(order.outputSchema, WORKER_OUTPUT_SCHEMA);
});

test("worker result requires externally verified skill usage", () => {
  const order = buildWorkOrder({
    role: "review-worker",
    taskId: "r1",
    goal: "g1",
    objective: "Deep review a worker diff",
    ownedScope: "worktrees/t1"
  });
  const invalid = validateWorkerResult(order, {
    status: "done",
    evidence: {
      skill_read: "declared",
      files_changed: [],
      commands_run: []
    },
    risks: []
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /externally verified/);

  const valid = validateWorkerResult(order, {
    status: "done",
    evidence: {
      skill_read: "externally-verified",
      files_changed: [],
      commands_run: ["npm test"]
    },
    risks: []
  });
  assert.equal(valid.ok, true);
});
