import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ButlerService } from "../src/butlerService.js";

const execFileAsync = promisify(execFile);

test("service creates goals, tasks, dispatches, verifies, and promotes no-diff tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient({
      status: "done",
      summary: "verified no-diff task",
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

test("service routes malformed worker handoff to rework", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient(malformedWorkerResult())
  });

  const goal = await service.submitGoal({ objective: "exercise rework path" });
  const task = await service.createTask({
    goalId: goal.id,
    role: "review-worker",
    objective: "claim review without external evidence"
  });
  const dispatched = await service.dispatchTask({ taskId: task.id });
  assert.equal(dispatched.state, "rework");
  assert.match(dispatched.handoff.validation.errors.join("\n"), /status must be/);
});

test("service repairs malformed worker handoff with a structured follow-up turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClientSequence([
      "I cannot return the handoff yet.",
      {
        status: "done",
        summary: "repaired structured handoff",
        evidence: { skill_read: "declared", files_changed: [], commands_run: [] },
        risks: []
      }
    ])
  });

  const goal = await service.submitGoal({ objective: "exercise repair path" });
  const task = await service.createTask({
    goalId: goal.id,
    role: "verifier",
    objective: "return a valid structured handoff after repair"
  });
  const dispatched = await service.dispatchTask({ taskId: task.id });
  assert.equal(dispatched.state, "validating");
  assert.equal(dispatched.handoff.repairedFromTurnId, "turn-test-1");
});

test("service accepts declared skill evidence when Butler loaded the required skill", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = await mkdtemp(join(tmpdir(), "codex-butler-home-"));
  await mkdir(join(codexHome, "skills", "review"), { recursive: true });
  await writeFile(join(codexHome, "skills", "review", "SKILL.md"), "# Review\n");
  process.env.CODEX_HOME = codexHome;
  try {
    const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
    const service = new ButlerService({
      projectRoot: dir,
      clientFactory: () => fakeClient({
        status: "done",
        summary: "loaded required skill",
        evidence: { skill_read: "declared", files_changed: [], commands_run: [] },
        risks: []
      })
    });

    const goal = await service.submitGoal({ objective: "exercise loaded skill path" });
    const task = await service.createTask({
      goalId: goal.id,
      role: "review-worker",
      objective: "use controller-loaded review skill"
    });
    const dispatched = await service.dispatchTask({ taskId: task.id });
    assert.equal(dispatched.state, "verified");
    assert.equal(dispatched.history[0].evidence.workOrder.requiredSkillLoaded, true);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("failed verifier records failure event and routes task to rework", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient({
      status: "done",
      summary: "valid handoff before verifier failure",
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

test("service blocks dispatch until prerequisites are verified or promoted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({ projectRoot: dir });
  const planned = await service.planGoal({ objective: "Build an ordered feature" });

  await assert.rejects(
    () => service.dispatchTask({ taskId: planned.tasks[1].id }),
    /unmet prerequisites/
  );
});

test("service advances a planned goal through the product pipeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  await initGitRepo(dir);
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient({
      status: "done",
      summary: "completed no-diff product pipeline",
      evidence: { skill_read: "externally-verified", files_changed: [], commands_run: [] },
      risks: []
    })
  });

  const planned = await service.planGoal({
    objective: "Build a no-diff feature",
    verificationCommand: [process.execPath, "-e", "process.exit(0)"]
  });
  const result = await service.advanceGoal({ goalId: planned.goal.id, maxSteps: 10 });

  assert.equal(result.ok, true);
  assert.equal(result.goal.state, "done");
  assert.deepEqual(result.actions.map((action) => action.action), [
    "allocate-and-dispatch",
    "dispatch",
    "verify",
    "promote",
    "done"
  ]);

  const tasks = Object.fromEntries(result.tasks.map((task) => [task.ownerRole, task.state]));
  assert.equal(tasks["iteration-worker"], "promoted");
  assert.equal(tasks["review-worker"], "verified");
  assert.equal(tasks.verifier, "verified");
  assert.equal(tasks.promoter, "promoted");
});

test("service reports stalled goal progress when auto-advance hits rework", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  await initGitRepo(dir);
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient(malformedWorkerResult())
  });

  const planned = await service.planGoal({
    objective: "Build a no-diff feature",
    verificationCommand: [process.execPath, "-e", "process.exit(0)"]
  });
  const result = await service.advanceGoal({ goalId: planned.goal.id, maxSteps: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.progress.status, "stalled");
  assert.equal(result.progress.taskState, "rework");
  assert.match(result.progress.message, /自动推进已停止/);
  assert.match(result.progress.details.join("\n"), /status must be/);
  assert.ok(result.actions.some((action) => action.action === "auto-retry"));
});

test("service reports active progress before downstream waiting tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({ projectRoot: dir });
  const planned = await service.planGoal({
    objective: "Build a product-ready flow",
    verificationCommand: [process.execPath, "-e", "process.exit(0)"]
  });

  const state = await service.state.load();
  const activeTask = planned.tasks[0];
  state.tasks[activeTask.id] = {
    ...state.tasks[activeTask.id],
    state: "awaiting_result"
  };
  await service.state.save(state);

  const dashboard = await service.dashboard();
  const progress = dashboard.goalProgress[planned.goal.id];
  assert.equal(progress.status, "active");
  assert.equal(progress.taskId, activeTask.id);
  assert.equal(progress.taskState, "awaiting_result");
  assert.match(progress.message, /正在处理/);
});

test("service can retry a task stopped in rework", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => fakeClient(malformedWorkerResult())
  });

  const goal = await service.submitGoal({ objective: "exercise retry path" });
  const task = await service.createTask({
    goalId: goal.id,
    role: "review-worker",
    objective: "claim review without external evidence"
  });
  const dispatched = await service.dispatchTask({ taskId: task.id });
  assert.equal(dispatched.state, "rework");

  const retried = await service.retryTask({ taskId: task.id });
  assert.equal(retried.state, "queued");
  assert.equal(retried.leaseId, null);
  assert.equal(retried.handoff, undefined);

  const events = await service.readLedger();
  assert.equal(events.at(-1).type, "task.requeued");
});

test("verifier and promoter gate tasks target the implementation task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({ projectRoot: dir });
  const planned = await service.planGoal({ objective: "Build a no-diff feature" });
  const implementation = {
    ...planned.tasks[0],
    state: "validating"
  };
  const review = {
    ...planned.tasks[1],
    state: "verified"
  };
  const state = await service.state.load();
  state.tasks[implementation.id] = implementation;
  state.tasks[review.id] = review;
  await service.state.save(state);

  const verifiedGate = await service.runVerifier({
    taskId: planned.tasks[2].id,
    command: [process.execPath, "-e", "process.exit(0)"]
  });
  assert.equal(verifiedGate.state, "verified");

  const verifiedState = await service.status();
  const verifiedImplementation = verifiedState.tasks.find((task) => task.id === implementation.id);
  assert.equal(verifiedImplementation.state, "verified");

  const promoted = await service.promoteTask({ taskId: planned.tasks[3].id });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.task.state, "promoted");
  assert.equal(promoted.targetTask.state, "promoted");
});

test("service registers existing sessions and marks one as the Butler controller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({ projectRoot: dir });

  const worker = await service.registerSession({
    threadId: "thread-existing-worker",
    role: "worker-session",
    label: "Existing worker"
  });
  const butler = await service.addButlerSession({
    threadId: "thread-existing-butler",
    label: "Existing Butler"
  });
  const updated = await service.addButlerSession({
    threadId: "thread-existing-butler",
    label: "Desktop Butler"
  });

  assert.equal(worker.role, "worker-session");
  assert.equal(butler.role, "butler-controller");
  assert.equal(updated.id, butler.id);
  assert.equal(updated.label, "Desktop Butler");

  const status = await service.status();
  assert.equal(status.sessions.length, 2);
  assert.equal(status.sessions.find((session) => session.id === butler.id).managed, true);

  const onlyButler = await service.listSessions({ role: "butler-controller" });
  assert.deepEqual(onlyButler.map((session) => session.id), [butler.id]);

  const events = await service.readLedger();
  assert.deepEqual(events.map((event) => event.type), [
    "session.registered",
    "session.registered",
    "session.updated"
  ]);
});

test("service probes managed session reachability and records health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => ({
      async startTurn({ threadId }) {
        return {
          start: { turn: { id: "turn-start" } },
          completed: { params: { turn: { id: "turn-probe", status: "completed" } } },
          finalText: JSON.stringify({ status: "ok", role: "session-probe" }),
          threadId
        };
      },
      close() {}
    })
  });

  const session = await service.addButlerSession({
    threadId: "thread-probe",
    label: "Probe Butler"
  });
  const probe = await service.probeSession({ sessionIdOrThreadId: session.id });
  assert.equal(probe.ok, true);
  assert.equal(probe.turnId, "turn-probe");

  const status = await service.status();
  const updated = status.sessions.find((item) => item.id === session.id);
  assert.equal(updated.health.status, "reachable");

  const events = await service.readLedger();
  assert.equal(events.at(-1).type, "session.probed");
});

test("service probes every managed session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => ({
      async startTurn() {
        return {
          start: { turn: { id: "turn-start" } },
          completed: { params: { turn: { id: "turn-probe", status: "completed" } } },
          finalText: JSON.stringify({ status: "ok", role: "session-probe" })
        };
      },
      close() {}
    })
  });

  await service.addButlerSession({ threadId: "thread-one" });
  await service.registerSession({ threadId: "thread-two", role: "worker-session" });

  const result = await service.probeAllSessions();
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(result.reachable, 2);
});

test("service registers and probes the current attached Butler session", async () => {
  const previousThreadId = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "thread-current";
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => ({
      async startTurn() {
        throw new Error("attached sessions must not use app-server turns");
      },
      close() {}
    })
  });
  try {
    await service.registerSession({
      threadId: "thread-current",
      role: "worker-session",
      label: "Imported worker"
    });
    const current = await service.addCurrentButlerSession({
      label: "Current Butler"
    });
    assert.equal(current.source, "current-session");
    assert.equal(current.health.status, "attached");

    const probe = await service.probeSession({ sessionIdOrThreadId: "thread-current" });
    assert.equal(probe.ok, true);
    assert.equal(probe.mode, "current-session");
    assert.equal(probe.sessionId, current.id);

    const status = await service.status();
    const attached = status.sessions.find((session) => session.id === current.id);
    assert.equal(attached.health.status, "attached");
  } finally {
    if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThreadId;
  }
});

test("service requires CODEX_THREAD_ID before registering the current Butler session", async () => {
  const previousThreadId = process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_THREAD_ID;
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({ projectRoot: dir });
  try {
    await assert.rejects(
      () => service.addCurrentButlerSession(),
      /CODEX_THREAD_ID is required/
    );
  } finally {
    if (previousThreadId !== undefined) process.env.CODEX_THREAD_ID = previousThreadId;
  }
});

test("service marks managed session unreachable when probe turn fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-service-"));
  const service = new ButlerService({
    projectRoot: dir,
    clientFactory: () => ({
      async startTurn() {
        throw new Error("thread not found");
      },
      close() {}
    })
  });

  const session = await service.addButlerSession({
    threadId: "thread-missing",
    label: "Missing Butler"
  });
  const probe = await service.probeSession({ sessionIdOrThreadId: "thread-missing" });
  assert.equal(probe.ok, false);
  assert.match(probe.error, /thread not found/);

  const status = await service.status();
  const updated = status.sessions.find((item) => item.id === session.id);
  assert.equal(updated.health.status, "unreachable");
});

function fakeClient(result) {
  return fakeClientSequence([result]);
}

function fakeClientSequence(results) {
  let index = 0;
  return {
    async startEphemeralThread() {
      return { thread: { id: "thread-test" } };
    },
    async startTurn() {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return {
        completed: { params: { turn: { id: `turn-test-${index}`, status: "completed" } } },
        finalText: typeof result === "string" ? result : JSON.stringify(result)
      };
    },
    close() {}
  };
}

function malformedWorkerResult() {
  return {
    status: "bad",
    evidence: { skill_read: "bad" },
    risks: null
  };
}

async function initGitRepo(dir) {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Codex Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
}
