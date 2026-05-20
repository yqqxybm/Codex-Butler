import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ButlerService } from "../src/butlerService.js";

test("service creates goals, tasks, dispatches, verifies, and promotes no-diff tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient({
      status: "done",
      evidence: { skill_read: "declared", files_changed: [], commands_run: [] },
      risks: []
    })
  });

  const goal = await service.submitGoal({ objective: "exercise service path" });
  const task = await service.createTask({
    goalId: goal.id,
    role: "verifier",
    objective: "return a valid structured handoff"
  });
  const dispatched = await service.dispatchTask({ taskId: task.id });
  assert.equal(dispatched.state, "validating");

  const verified = await service.runVerifier({
    taskId: task.id,
    command: [process.execPath, "-e", "process.exit(0)"]
  });
  assert.equal(verified.state, "verified");

  const promoted = await service.promoteTask({ taskId: task.id });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.task.state, "promoted");
});

test("service routes invalid skill evidence to rework", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient({
      status: "done",
      evidence: { skill_read: "declared", files_changed: [], commands_run: [] },
      risks: []
    })
  });

  const goal = await service.submitGoal({ objective: "exercise rework path" });
  const task = await service.createTask({
    goalId: goal.id,
    role: "review-worker",
    objective: "claim review without external evidence"
  });
  const dispatched = await service.dispatchTask({ taskId: task.id });
  assert.equal(dispatched.state, "rework");
  assert.match(dispatched.handoff.validation.errors.join("\n"), /externally verified/);
});

test("failed verifier records failure event and routes task to rework", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient({
      status: "done",
      evidence: { skill_read: "declared", files_changed: [], commands_run: [] },
      risks: []
    })
  });

  const goal = await service.submitGoal({ objective: "exercise failed verifier path" });
  const task = await service.createTask({
    goalId: goal.id,
    role: "verifier",
    objective: "return a valid structured handoff"
  });
  const dispatched = await service.dispatchTask({ taskId: task.id });
  assert.equal(dispatched.state, "validating");

  const verified = await service.runVerifier({
    taskId: task.id,
    command: [process.execPath, "-e", "process.exit(7)"]
  });
  assert.equal(verified.state, "rework");

  const events = await service.readLedger();
  assert.equal(events.at(-1).type, "task.verification_failed");
  assert.equal(events.at(-1).payload.exitCode, 7);
});

function fakeClient(result) {
  return {
    async startEphemeralThread() {
      return { thread: { id: "thread-test" } };
    },
    async startTurn() {
      return {
        completed: { params: { turn: { id: "turn-test", status: "completed" } } },
        finalText: JSON.stringify(result)
      };
    },
    close() {}
  };
}
