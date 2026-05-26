import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkOrder, validateWorkerResult, WORKER_OUTPUT_SCHEMA } from "../src/roleContracts.js";

test("iteration worker work order carries the required skill and forbidden actions", () => {
  const order = buildWorkOrder({
    role: "iteration-worker",
    taskId: "t1",
    goal: "g1",
    objective: "Change code in a task worktree",
    ownedScope: "worktrees/t1",
    contextNotes: [{ note: "Prefer product usability." }]
  });
  assert.equal(order.requiredSkill, "project-iteration");
  assert.match(order.requiredSkillPath, /\/\.codex\/skills\/project-iteration\/SKILL\.md$/);
  assert.ok(order.forbidden.includes("edit_main_workspace"));
  assert.deepEqual(order.contextNotes, [{ note: "Prefer product usability." }]);
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
    summary: "reviewed worker output",
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
    summary: "reviewed worker output",
    evidence: {
      skill_read: "externally-verified",
      files_changed: [],
      commands_run: ["npm test"]
    },
    risks: []
  });
  assert.equal(valid.ok, true);
});

test("worker output schema is strict-compatible with app-server response format", () => {
  assertStrictRequiredProperties(WORKER_OUTPUT_SCHEMA);
});

function assertStrictRequiredProperties(schema, path = "$") {
  if (!schema?.properties) return;
  assert.deepEqual(
    new Set(schema.required),
    new Set(Object.keys(schema.properties)),
    `${path} required must include every declared property`
  );
  for (const [key, value] of Object.entries(schema.properties)) {
    assertStrictRequiredProperties(value, `${path}.${key}`);
  }
}
