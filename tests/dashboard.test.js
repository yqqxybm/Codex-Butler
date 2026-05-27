import test from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "../src/dashboard.js";

test("dashboard renders goals, task states, and recent events as text", () => {
  const text = renderDashboard({
    projectRoot: "/repo",
    dataDir: "/repo/.codex-butler",
    goals: [{
      id: "goal-1",
      objective: "Ship feature",
      state: "running"
    }],
    tasks: [{
      id: "task-1",
      objective: "Implement feature",
      ownerRole: "iteration-worker",
      state: "queued"
    }],
    sessions: [{
      id: "session-1",
      threadId: "thread-butler",
      label: "Existing Butler",
      role: "butler-controller",
      source: "existing-local",
      health: { status: "reachable" }
    }, {
      id: "session-2",
      threadId: "thread-current",
      label: "Current Butler",
      role: "butler-controller",
      source: "current-session",
      health: { status: "attached" }
    }]
  }, [{
    type: "task.created",
    at: "2026-05-20T00:00:00.000Z",
    payload: { taskId: "task-1" }
  }]);

  assert.match(text, /Codex Butler Dashboard/);
  assert.match(text, /Goals: 1 total, 1 active, 0 done, 0 blocked/);
  assert.match(text, /queued: 1/);
  assert.match(text, /Sessions: 2 managed, 2 butler, 1 reachable butler, 1 attached current-session/);
  assert.match(text, /Existing Butler -> thread-butler/);
  assert.match(text, /task\.created/);
});
