import test from "node:test";
import assert from "node:assert/strict";
import { createGoal, createTask, isTerminal, transition } from "../src/stateMachine.js";

test("goal follows the planned happy path", () => {
  let goal = createGoal("g1", "Build the control plane");
  goal = transition(goal, "planned", { source: "test" });
  goal = transition(goal, "running", { source: "test" });
  goal = transition(goal, "reviewing", { source: "test" });
  goal = transition(goal, "promoting", { source: "test" });
  goal = transition(goal, "done", { source: "test" });
  assert.equal(goal.state, "done");
  assert.equal(isTerminal(goal), true);
  assert.equal(goal.history.length, 5);
});

test("task rework loop returns to queued", () => {
  let task = createTask("t1", "g1", "Implement worker transport", "iteration-worker");
  task = transition(task, "leased");
  task = transition(task, "dispatched");
  task = transition(task, "awaiting_result");
  task = transition(task, "validating");
  task = transition(task, "rework", { reason: "review finding" });
  task = transition(task, "queued", { reason: "needs patch" });
  assert.equal(task.state, "queued");
});

test("invalid transitions are rejected", () => {
  const task = createTask("t2", "g1", "Skip straight to promotion", "promoter");
  assert.throws(() => transition(task, "promoted"), /Invalid task transition/);
});
