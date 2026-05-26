import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EventLedger } from "./ledger.js";
import { StateStore } from "./stateStore.js";
import { createGoal, createTask, transition } from "./stateMachine.js";
import { buildWorkOrder, validateWorkerResult, WORKER_OUTPUT_SCHEMA } from "./roleContracts.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import { allocateWorktree, promoteWorktree } from "./worktree.js";
import { runCommand } from "./exec.js";
import { compilePlan } from "./planCompiler.js";
import { applyTranscriptEvidence, extractSkillReadEvidence } from "./evidence.js";
import { renderDashboard } from "./dashboard.js";
import { readDaemonStatus, startDaemon, stopDaemon } from "./daemon.js";

export const SESSION_ROLES = Object.freeze([
  "butler-controller",
  "worker-session",
  "iteration-worker",
  "review-worker",
  "analysis-worker",
  "refine-worker",
  "verifier",
  "promoter"
]);

export const SESSION_SOURCES = Object.freeze([
  "existing-local",
  "app-server",
  "current-session",
  "manual"
]);

export class ButlerService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.dataDir = options.dataDir ?? join(this.projectRoot, ".codex-butler");
    this.state = new StateStore(options.statePath ?? join(this.dataDir, "state.json"));
    this.ledger = new EventLedger(options.ledgerPath ?? join(this.dataDir, "events.jsonl"));
    this.clientFactory = options.clientFactory ?? (() => new CodexAppServerClient({ cwd: this.projectRoot }));
  }

  async submitGoal({ objective }) {
    const state = await this.state.load();
    const goal = createGoal(`goal-${randomUUID()}`, objective);
    state.goals[goal.id] = goal;
    await this.state.save(state);
    await this.ledger.append("goal.submitted", { goalId: goal.id, objective });
    return goal;
  }

  async createTask({
    goalId,
    role,
    objective,
    ownedScope = this.projectRoot,
    prerequisites = [],
    verificationCommand = null,
    planItemId = null,
    targetTaskId = null
  }) {
    const state = await this.state.load();
    const goal = state.goals[goalId];
    if (!goal) throw new Error(`Unknown goal: ${goalId}`);
    const task = createTask(`task-${randomUUID()}`, goalId, objective, role);
    task.ownedScope = ownedScope;
    task.prerequisites = prerequisites;
    task.verificationCommand = verificationCommand;
    task.planItemId = planItemId;
    task.targetTaskId = targetTaskId;
    state.tasks[task.id] = task;
    if (goal.state === "intake") state.goals[goalId] = transition(goal, "planned", { taskId: task.id });
    await this.state.save(state);
    await this.ledger.append("task.created", {
      goalId,
      taskId: task.id,
      role,
      objective,
      ownedScope,
      prerequisites,
      verificationCommand,
      planItemId,
      targetTaskId
    });
    return state.tasks[task.id];
  }

  async planGoal({ objective, ownedScope = this.projectRoot, verificationCommand = ["npm", "test"] }) {
    const plan = compilePlan({
      objective,
      projectRoot: this.projectRoot,
      ownedScope,
      verificationCommand
    });
    const goal = await this.submitGoal({ objective });
    const planIdToTaskId = new Map();
    const tasks = [];
    for (const item of plan.tasks) {
      const task = await this.createTask({
        goalId: goal.id,
        role: item.role,
        objective: item.objective,
        ownedScope: item.ownedScope,
        prerequisites: item.prerequisites.map((id) => planIdToTaskId.get(id) ?? id),
        verificationCommand: item.verificationCommand,
        planItemId: item.id,
        targetTaskId: item.targetPlanItemId ? planIdToTaskId.get(item.targetPlanItemId) ?? null : null
      });
      planIdToTaskId.set(item.id, task.id);
      tasks.push(task);
    }
    const state = await this.state.load();
    await this.ledger.append("goal.planned", {
      goalId: goal.id,
      taskIds: tasks.map((task) => task.id),
      classification: plan.classification
    });
    return { goal: state.goals[goal.id], plan, tasks };
  }

  async replanGoal({ goalId, ownedScope = this.projectRoot, verificationCommand = ["npm", "test"] }) {
    const state = await this.state.load();
    const goal = requiredGoal(state, goalId);
    const existingTasks = orderedGoalTasks(state, goal.id);
    const nonQueuedTasks = existingTasks.filter((task) => task.state !== "queued");
    if (nonQueuedTasks.length > 0) {
      throw new Error(`Goal ${goalId} cannot be replanned after work started: ${nonQueuedTasks.map((task) => task.id).join(", ")}`);
    }

    for (const task of existingTasks) {
      delete state.tasks[task.id];
    }
    await this.state.save(state);

    const plan = compilePlan({
      objective: goal.objective,
      projectRoot: this.projectRoot,
      ownedScope,
      verificationCommand
    });
    const planIdToTaskId = new Map();
    const tasks = [];
    for (const item of plan.tasks) {
      const task = await this.createTask({
        goalId: goal.id,
        role: item.role,
        objective: item.objective,
        ownedScope: item.ownedScope,
        prerequisites: item.prerequisites.map((id) => planIdToTaskId.get(id) ?? id),
        verificationCommand: item.verificationCommand,
        planItemId: item.id,
        targetTaskId: item.targetPlanItemId ? planIdToTaskId.get(item.targetPlanItemId) ?? null : null
      });
      planIdToTaskId.set(item.id, task.id);
      tasks.push(task);
    }
    const nextState = await this.state.load();
    await this.ledger.append("goal.replanned", {
      goalId: goal.id,
      removedTaskIds: existingTasks.map((task) => task.id),
      taskIds: tasks.map((task) => task.id),
      classification: plan.classification
    });
    return { goal: nextState.goals[goal.id], plan, tasks };
  }

  async registerSession({
    threadId,
    role = "worker-session",
    label = null,
    source = "existing-local",
    cwd = null,
    notes = null
  }) {
    const normalizedThreadId = requiredText(threadId, "threadId");
    const normalizedRole = normalizeSessionRole(role);
    const normalizedSource = normalizeSessionSource(source);
    const state = await this.state.load();
    const now = new Date().toISOString();
    const existing = Object.values(state.sessions)
      .find((session) => session.threadId === normalizedThreadId && session.role === normalizedRole);
    const session = {
      kind: "session",
      id: existing?.id ?? `session-${randomUUID()}`,
      threadId: normalizedThreadId,
      role: normalizedRole,
      label: optionalText(label) ?? existing?.label ?? defaultSessionLabel(normalizedRole),
      source: normalizedSource,
      managed: true,
      cwd: optionalText(cwd) ?? existing?.cwd ?? this.projectRoot,
      notes: optionalText(notes) ?? existing?.notes ?? null,
      health: existing?.health,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (!session.health) delete session.health;
    state.sessions[session.id] = session;
    await this.state.save(state);
    await this.ledger.append(existing ? "session.updated" : "session.registered", {
      sessionId: session.id,
      threadId: session.threadId,
      role: session.role,
      source: session.source
    });
    return session;
  }

  async addButlerSession({ threadId, label = null, source = "existing-local", cwd = null, notes = null }) {
    return this.registerSession({
      threadId,
      role: "butler-controller",
      label,
      source,
      cwd,
      notes
    });
  }

  async addCurrentButlerSession({ label = null, cwd = null, notes = null } = {}) {
    const threadId = requiredText(process.env.CODEX_THREAD_ID, "CODEX_THREAD_ID");
    const session = await this.registerSession({
      threadId,
      role: "butler-controller",
      label: label ?? "Current Codex Butler",
      source: "current-session",
      cwd,
      notes: notes ?? "Current active Codex session attached through CODEX_THREAD_ID; not an app-server dispatch target."
    });
    const state = await this.state.load();
    const attached = markSessionAttached(state.sessions[session.id]);
    state.sessions[session.id] = attached;
    await this.state.save(state);
    await this.ledger.append("session.attached", {
      sessionId: attached.id,
      threadId: attached.threadId,
      role: attached.role,
      source: attached.source
    });
    return attached;
  }

  async listSessions({ role = null } = {}) {
    const state = await this.state.load();
    const sessions = Object.values(state.sessions);
    if (!role) return sessions;
    const normalizedRole = normalizeSessionRole(role);
    return sessions.filter((session) => session.role === normalizedRole);
  }

  async probeSession({ sessionIdOrThreadId }) {
    const target = requiredText(sessionIdOrThreadId, "sessionIdOrThreadId");
    const state = await this.state.load();
    const session = resolveSessionTarget(state, target);
    if (!session) throw new Error(`Unknown session: ${target}`);

    if (isCurrentAttachedSession(session)) {
      const attached = markSessionAttached(session);
      state.sessions[attached.id] = attached;
      const result = {
        ok: true,
        mode: "current-session",
        sessionId: attached.id,
        threadId: attached.threadId,
        turnId: null,
        turnStatus: "attached",
        finalText: null,
        error: null
      };
      await this.state.save(state);
      await this.ledger.append("session.probed", {
        sessionId: attached.id,
        threadId: attached.threadId,
        ok: result.ok,
        turnId: null,
        mode: result.mode,
        error: null
      });
      return result;
    }

    const client = this.clientFactory();
    let result;
    try {
      const turn = await client.startTurn({
        threadId: session.threadId,
        inputText: "Return JSON only: {\"status\":\"ok\",\"role\":\"session-probe\"}. Do not run tools.",
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["status", "role"],
          properties: {
            status: { type: "string", enum: ["ok"] },
            role: { type: "string", enum: ["session-probe"] }
          }
        },
        cwd: session.cwd ?? this.projectRoot,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        timeoutMs: 60000
      });
      const parsed = parseJson(turn.finalText);
      result = {
        ok: turn.completed.params?.turn?.status === "completed" && parsed?.status === "ok",
        sessionId: session.id,
        threadId: session.threadId,
        turnId: turn.completed.params?.turn?.id ?? turn.start?.turn?.id ?? null,
        turnStatus: turn.completed.params?.turn?.status ?? null,
        finalText: turn.finalText,
        error: null
      };
    } catch (error) {
      result = {
        ok: false,
        sessionId: session.id,
        threadId: session.threadId,
        turnId: null,
        turnStatus: null,
        finalText: null,
        error: error.message
      };
    } finally {
      client.close();
    }

    session.health = {
      status: result.ok ? "reachable" : "unreachable",
      probedAt: new Date().toISOString(),
      turnId: result.turnId,
      error: result.error
    };
    state.sessions[session.id] = session;
    await this.state.save(state);
    await this.ledger.append("session.probed", {
      sessionId: session.id,
      threadId: session.threadId,
      ok: result.ok,
      turnId: result.turnId,
      error: result.error
    });
    return result;
  }

  async probeAllSessions() {
    const sessions = await this.listSessions();
    const results = [];
    for (const session of sessions) {
      results.push(await this.probeSession({ sessionIdOrThreadId: session.id }));
    }
    return {
      ok: results.every((result) => result.ok),
      total: results.length,
      reachable: results.filter((result) => result.ok).length,
      results
    };
  }

  async advanceGoal({ goalId, maxSteps = 1 }) {
    const normalizedGoalId = requiredText(goalId, "goalId");
    const stepLimit = Math.max(1, Math.min(Number(maxSteps) || 1, 20));
    const actions = [];

    for (let index = 0; index < stepLimit; index += 1) {
      const state = await this.state.load();
      const goal = requiredGoal(state, normalizedGoalId);
      const tasks = orderedGoalTasks(state, goal.id);
      const task = tasks.find((candidate) => isRunnableTask(state, candidate));

      if (!task) {
        const progress = describeGoalProgress(state, goal.id);
        if (progress.recoverable && autoRecoverCount(state.tasks[progress.taskId]) < 1) {
          const retried = await this.retryTask({ taskId: progress.taskId, source: "auto-retry" });
          actions.push({
            action: "auto-retry",
            ok: true,
            taskId: retried.id,
            state: retried.state,
            reason: "recoverable worker handoff issue was requeued automatically"
          });
          continue;
        }
        actions.push({
          action: progress.complete ? "done" : "blocked",
          ok: progress.complete,
          reason: progress.message,
          taskId: progress.taskId ?? null,
          state: progress.taskState ?? null,
          progress
        });
        break;
      }

      const action = await this.advanceTask(task);
      actions.push(action);
      await this.refreshGoalState(normalizedGoalId);
      if (action.ok === false) {
        const nextState = await this.state.load();
        const failedTask = nextState.tasks[action.taskId];
        if (isRecoverableTask(failedTask) && autoRecoverCount(failedTask) < 1) {
          const retried = await this.retryTask({ taskId: failedTask.id, source: "auto-retry" });
          actions.push({
            action: "auto-retry",
            ok: true,
            taskId: retried.id,
            state: retried.state,
            reason: "recoverable worker handoff issue was requeued automatically"
          });
          continue;
        }
      }
      if (action.ok === false) break;
    }

    await this.refreshGoalState(normalizedGoalId);
    const status = await this.status();
    const goal = status.goals.find((item) => item.id === normalizedGoalId);
    const tasks = status.tasks.filter((task) => task.goalId === normalizedGoalId);
    const progress = describeGoalProgress(statusToState(status), normalizedGoalId);
    return {
      ok: actions.length > 0 && actions.every((action) => action.ok !== false) && progress.status !== "stalled",
      goal,
      tasks,
      actions,
      progress
    };
  }

  async advanceTask(task) {
    if (task.ownerRole === "verifier") {
      const result = await this.runVerifier({ taskId: task.id });
      return {
        action: "verify",
        ok: result.state === "verified",
        taskId: task.id,
        state: result.state
      };
    }

    if (task.ownerRole === "promoter") {
      const result = await this.promoteTask({ taskId: task.id });
      return {
        action: "promote",
        ok: result.ok,
        taskId: task.id,
        state: result.task.state,
        result: result.result
      };
    }

    let worktree = null;
    if (needsWorktree(task) && !task.worktreePath) {
      worktree = await this.allocateTaskWorktree({ taskId: task.id });
      if (!worktree.ok) {
        return {
          action: "allocate-worktree",
          ok: false,
          taskId: task.id,
          result: worktree
        };
      }
    }

    const result = await this.dispatchTask({ taskId: task.id });
    return {
      action: worktree ? "allocate-and-dispatch" : "dispatch",
      ok: !["blocked", "failed", "rework"].includes(result.state),
      taskId: task.id,
      state: result.state,
      worktreePath: result.worktreePath ?? null
    };
  }

  async refreshGoalState(goalId) {
    const state = await this.state.load();
    let goal = requiredGoal(state, goalId);
    const tasks = orderedGoalTasks(state, goal.id);
    const desired = desiredGoalState(tasks);
    goal = transitionGoalToward(goal, desired);
    state.goals[goal.id] = goal;
    await this.state.save(state);
    return goal;
  }

  async dispatchTask({ taskId }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    assertPrerequisitesMet(state, task);
    const goal = requiredGoal(state, task.goalId);
    const workOrder = buildWorkOrder({
      role: task.ownerRole,
      taskId,
      goal: goal.objective,
      objective: task.objective,
      ownedScope: task.ownedScope,
      targetTaskId: task.targetTaskId
    });
    const skillSource = await loadRequiredSkill(workOrder);
    if (skillSource.ok) {
      workOrder.requiredSkillLoaded = true;
      workOrder.requiredSkillDigest = skillSource.digest;
    }

    task = transition(task, "leased", { workOrder });
    task.leaseId = `lease-${randomUUID()}`;
    task = transition(task, "dispatched", { leaseId: task.leaseId });
    task = transition(task, "awaiting_result", { transport: "app-server-turn" });
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append("task.dispatched", { taskId, leaseId: task.leaseId, workOrder });

    const client = this.clientFactory();
    const workerCwd = task.worktreePath ?? this.projectRoot;
    const sandboxPolicy = task.worktreePath
      ? { type: "workspaceWrite", networkAccess: false, writableRoots: [task.worktreePath] }
      : { type: "readOnly", networkAccess: false };
    const prompt = workerPrompt(workOrder, skillSource);
    try {
      const thread = await client.startEphemeralThread(workerCwd, {
        sandbox: task.worktreePath ? "workspace-write" : "read-only"
      });
      const turn = await client.startTurn({
        threadId: thread.thread.id,
        inputText: prompt,
        outputSchema: WORKER_OUTPUT_SCHEMA,
        cwd: workerCwd,
        sandboxPolicy
      });
      const handoff = await this.parseWorkerHandoff({ turn, workOrder, prompt, client, threadId: thread.thread.id, workerCwd, sandboxPolicy });
      task.threadId = thread.thread.id;
      task.turnId = handoff.turnId;
      task.handoff = handoff.handoff;
      if (handoff.parsed?.status === "blocked") {
        task = transition(task, "blocked", { validation: handoff.validation });
      } else {
        task = transition(task, "validating", { validation: handoff.validation });
        if (!handoff.validation.ok || handoff.parsed?.status === "needs_rework") {
          task = transition(task, "rework", { validation: handoff.validation });
        } else if (task.ownerRole === "analysis-worker" || task.ownerRole === "review-worker") {
          task = transition(task, "verified", { validation: handoff.validation });
        }
      }
      state.tasks[taskId] = task;
      await this.state.save(state);
      await this.ledger.append("task.handoff_received", { taskId, threadId: task.threadId, turnId: task.turnId, validation: handoff.validation });
      return task;
    } finally {
      client.close();
    }
  }

  async parseWorkerHandoff({ turn, workOrder, prompt, client, threadId, workerCwd, sandboxPolicy }) {
    const handoff = buildHandoff({ turn, workOrder, prompt });
    if (handoff.validation.ok || !isMalformedWorkerHandoff(handoff)) {
      return handoff;
    }

    const repairPrompt = [
      "Your previous answer could not be accepted by codex-butler.",
      "Return only JSON matching the outputSchema in the work order. No Markdown, no prose.",
      "If the task cannot be completed from the available context, use status \"blocked\" and explain the blocker in risks.",
      `Work order:\n${JSON.stringify(workOrder, null, 2)}`
    ].join("\n\n");
    const repairTurn = await client.startTurn({
      threadId,
      inputText: repairPrompt,
      outputSchema: WORKER_OUTPUT_SCHEMA,
      cwd: workerCwd,
      sandboxPolicy,
      timeoutMs: 120000
    });
    const repaired = buildHandoff({
      turn: repairTurn,
      workOrder,
      prompt: repairPrompt,
      repairedFromTurnId: handoff.turnId
    });
    return repaired.validation.ok ? repaired : handoff;
  }

  async allocateTaskWorktree({ taskId }) {
    const state = await this.state.load();
    const task = requiredTask(state, taskId);
    const result = await allocateWorktree(this.projectRoot, taskId);
    if (result.ok) {
      task.worktreePath = result.path;
      state.tasks[taskId] = task;
      await this.state.save(state);
    }
    await this.ledger.append("task.worktree_allocated", { taskId, result });
    return result;
  }

  async runVerifier({ taskId, command = null, cwd = null }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    assertPrerequisitesMet(state, task);
    let targetTask = task.targetTaskId ? requiredTask(state, task.targetTaskId) : task;
    if (task.ownerRole === "verifier" && task.state === "queued") {
      task = transition(task, "leased", { gate: "verifier" });
      task = transition(task, "dispatched", { gate: "verifier" });
      task = transition(task, "awaiting_result", { gate: "verifier" });
      task = transition(task, "validating", { gate: "verifier" });
    }
    if (!["validating", "review"].includes(task.state)) {
      throw new Error(`Task ${taskId} cannot be verified from state ${task.state}`);
    }
    const commandToRun = command ?? task.verificationCommand;
    if (!Array.isArray(commandToRun) || commandToRun.length === 0) {
      throw new Error(`Task ${taskId} has no verification command`);
    }
    const result = await runCommand(commandToRun[0], commandToRun.slice(1), {
      cwd: cwd ?? targetTask.worktreePath ?? task.worktreePath ?? this.projectRoot,
      timeoutMs: 120000
    });
    task.verification = {
      command: commandToRun,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
    task = result.exitCode === 0
      ? transition(task, "verified", { command: commandToRun, exitCode: result.exitCode })
      : transition(task, "rework", { command: commandToRun, exitCode: result.exitCode });
    if (task.targetTaskId && ["validating", "review"].includes(targetTask.state)) {
      targetTask = {
        ...targetTask,
        verification: task.verification
      };
      targetTask = result.exitCode === 0
        ? transition(targetTask, "verified", { verifierTaskId: task.id, command: commandToRun, exitCode: result.exitCode })
        : transition(targetTask, "rework", { verifierTaskId: task.id, command: commandToRun, exitCode: result.exitCode });
      state.tasks[targetTask.id] = targetTask;
    }
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append(result.exitCode === 0 ? "task.verified" : "task.verification_failed", {
      taskId,
      command: commandToRun,
      exitCode: result.exitCode
    });
    return task;
  }

  async promoteTask({ taskId }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    assertPrerequisitesMet(state, task);
    let targetTask = task.targetTaskId ? requiredTask(state, task.targetTaskId) : task;
    if (targetTask.state !== "verified") {
      throw new Error(`Task ${targetTask.id} must be verified before promotion`);
    }
    const result = targetTask.worktreePath
      ? await promoteWorktree(this.projectRoot, targetTask.worktreePath)
      : { ok: true, promoted: false, reason: "task has no worktree diff" };
    if (!result.ok) {
      await this.ledger.append("task.promotion_blocked", { taskId, targetTaskId: targetTask.id, result });
      return { ok: false, task, result };
    }
    targetTask = transition(targetTask, "promoted", result);
    state.tasks[targetTask.id] = targetTask;
    if (task.id !== targetTask.id) {
      task = completeGateTask(task, "promoter", result);
      state.tasks[task.id] = task;
    } else {
      task = targetTask;
    }
    await this.state.save(state);
    await this.ledger.append("task.promoted", { taskId, targetTaskId: targetTask.id, result });
    return { ok: true, task, targetTask, result };
  }

  async retryTask({ taskId, source = "manual-retry" }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    if (!["rework", "blocked"].includes(task.state)) {
      throw new Error(`Task ${taskId} cannot be retried from state ${task.state}`);
    }
    const previousState = task.state;
    task = transition(task, "queued", { source, previousState });
    task.leaseId = null;
    delete task.threadId;
    delete task.turnId;
    delete task.handoff;
    delete task.verification;
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append("task.requeued", { taskId, previousState, source });
    await this.refreshGoalState(task.goalId);
    return task;
  }

  async status() {
    const state = await this.state.load();
    return {
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      goals: Object.values(state.goals),
      tasks: Object.values(state.tasks),
      sessions: Object.values(state.sessions)
    };
  }

  async readLedger() {
    return this.ledger.readAll();
  }

  async dashboard() {
    const status = await this.status();
    const events = await this.readLedger();
    return {
      dashboard: renderDashboard(status, events),
      status,
      goalProgress: Object.fromEntries(status.goals.map((goal) => [
        goal.id,
        describeGoalProgress(statusToState(status), goal.id)
      ])),
      recentEvents: events.slice(-8)
    };
  }

  async daemonStatus() {
    return readDaemonStatus({ dataDir: this.dataDir });
  }

  async startDaemon() {
    return startDaemon({ projectRoot: this.projectRoot, dataDir: this.dataDir });
  }

  async stopDaemon() {
    return stopDaemon({ dataDir: this.dataDir });
  }
}

export function createDefaultService(options = {}) {
  return new ButlerService(options);
}

function requiredGoal(state, goalId) {
  const goal = state.goals[goalId];
  if (!goal) throw new Error(`Unknown goal: ${goalId}`);
  return goal;
}

function requiredTask(state, taskId) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}

function assertPrerequisitesMet(state, task) {
  const unmetPrerequisites = (task.prerequisites ?? [])
    .filter((id) => !isPrerequisiteMet(state, task, id));
  if (unmetPrerequisites.length > 0) {
    throw new Error(`Task ${task.id} has unmet prerequisites: ${unmetPrerequisites.join(", ")}`);
  }
}

function orderedGoalTasks(state, goalId) {
  return Object.values(state.tasks)
    .filter((task) => task.goalId === goalId)
    .sort((left, right) => taskOrder(left) - taskOrder(right));
}

function taskOrder(task) {
  const match = /^plan-(\d+)$/.exec(task.planItemId ?? "");
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function isRunnableTask(state, task) {
  if (task.state !== "queued") return false;
  return (task.prerequisites ?? []).every((id) => isPrerequisiteMet(state, task, id));
}

function isPrerequisiteMet(state, task, prerequisiteId) {
  const prerequisite = state.tasks[prerequisiteId];
  if (!prerequisite) return false;
  if (["verified", "promoted"].includes(prerequisite.state)) return true;
  if (task.ownerRole === "review-worker") {
    return ["validating", "review"].includes(prerequisite.state);
  }
  return false;
}

function isGoalComplete(tasks) {
  return tasks.length > 0 && tasks.every((task) => ["verified", "promoted"].includes(task.state));
}

function describeGoalProgress(state, goalId) {
  const goal = requiredGoal(state, goalId);
  const tasks = orderedGoalTasks(state, goal.id);
  if (isGoalComplete(tasks)) {
    return {
      status: "complete",
      complete: true,
      message: "目标已完成：全部任务都已验证或提升。",
      taskId: null,
      taskState: null,
      ownerRole: null,
      details: []
    };
  }

  const runnable = tasks.find((task) => isRunnableTask(state, task));
  if (runnable) {
    return {
      status: "runnable",
      complete: false,
      message: "下一步已经准备好，可以继续推进。",
      taskId: runnable.id,
      taskState: runnable.state,
      ownerRole: runnable.ownerRole,
      details: []
    };
  }

  const stalled = tasks.find((task) => ["rework", "blocked", "failed"].includes(task.state));
  if (stalled) {
    const details = taskIssueDetails(stalled);
    const recoverable = isRecoverableTask(stalled);
    const recoveries = autoRecoverCount(stalled);
    const message = stalled.state === "blocked"
      ? `自动推进已暂停：这一步需要你补充信息${details[0] ? `，${details[0]}` : "。"}`
      : recoverable && recoveries < 1
        ? "这一步交付格式不合格，但可以自动重跑一次。"
        : `自动推进已停止：这一步仍未给出合格交付${details[0] ? `，${details[0]}` : "。"}`;
    return {
      status: "stalled",
      complete: false,
      message,
      taskId: stalled.id,
      taskState: stalled.state,
      ownerRole: stalled.ownerRole,
      recoverable,
      recoveries,
      details
    };
  }

  const active = tasks.find((task) => ["leased", "dispatched", "awaiting_result", "validating", "review"].includes(task.state));
  if (active) {
    return {
      status: "active",
      complete: false,
      message: "管家正在处理当前步骤。",
      taskId: active.id,
      taskState: active.state,
      ownerRole: active.ownerRole,
      details: []
    };
  }

  const waiting = tasks.find((task) => task.state === "queued");
  if (waiting) {
    const unmetPrerequisites = (waiting.prerequisites ?? [])
      .filter((id) => !isPrerequisiteMet(state, waiting, id));
    return {
      status: "waiting",
      complete: false,
      message: "当前步骤还在等待前置结果完成。",
      taskId: waiting.id,
      taskState: waiting.state,
      ownerRole: waiting.ownerRole,
      unmetPrerequisites,
      details: []
    };
  }

  return {
    status: "empty",
    complete: false,
    message: "目标下没有可推进任务。",
    taskId: null,
    taskState: null,
    ownerRole: null,
    details: []
  };
}

function taskIssueDetails(task) {
  const validationErrors = task.handoff?.validation?.errors
    ?? latestHistoryValidationErrors(task)
    ?? [];
  const risks = Array.isArray(task.handoff?.result?.risks) ? task.handoff.result.risks : [];
  const blockedSummary = task.state === "blocked" && typeof task.handoff?.result?.summary === "string"
    ? [`需要确认：${task.handoff.result.summary}`]
    : [];
  const details = [...blockedSummary, ...validationErrors];
  if (task.verification?.exitCode && task.verification.exitCode !== 0) {
    details.push(`verification command exited ${task.verification.exitCode}: ${task.verification.command?.join(" ") ?? "unknown command"}`);
  }
  for (const risk of risks) details.push(`risk: ${risk}`);
  return details;
}

function isRecoverableTask(task) {
  if (!task || task.state !== "rework") return false;
  const errors = taskIssueDetails(task);
  return errors.some((error) => /status must be|evidence\.skill_read|files_changed|commands_run|risks must|externally verified/i.test(error));
}

function autoRecoverCount(task) {
  return (task?.history ?? []).filter((event) => event.from === "rework"
    && event.to === "queued"
    && event.evidence?.source === "auto-retry").length;
}

function latestHistoryValidationErrors(task) {
  for (const event of [...(task.history ?? [])].reverse()) {
    const errors = event.evidence?.validation?.errors;
    if (Array.isArray(errors) && errors.length > 0) return errors;
  }
  return [];
}

function statusToState(status) {
  return {
    goals: Object.fromEntries((status.goals ?? []).map((goal) => [goal.id, goal])),
    tasks: Object.fromEntries((status.tasks ?? []).map((task) => [task.id, task]))
  };
}

function shortTaskId(id) {
  return String(id).replace(/^task-/, "").slice(0, 8);
}

function desiredGoalState(tasks) {
  if (tasks.length === 0) return "planned";
  if (isGoalComplete(tasks)) return "done";
  if (tasks.some((task) => task.ownerRole === "promoter" && task.state !== "queued")) return "promoting";
  if (tasks.some((task) => ["review-worker", "verifier"].includes(task.ownerRole) && task.state !== "queued")) return "reviewing";
  if (tasks.some((task) => task.state !== "queued")) return "running";
  return "planned";
}

function transitionGoalToward(goal, desiredState) {
  const order = ["intake", "planned", "running", "reviewing", "promoting", "done"];
  const targetIndex = order.indexOf(desiredState);
  if (targetIndex === -1 || !order.includes(goal.state)) return goal;
  let current = goal;
  while (targetIndex > order.indexOf(current.state)) {
    current = transition(current, order[order.indexOf(current.state) + 1], { source: "goal-advance" });
  }
  return current;
}

function needsWorktree(task) {
  return ["iteration-worker", "refine-worker"].includes(task.ownerRole);
}

async function loadRequiredSkill(workOrder) {
  if (!workOrder.requiredSkillPath) {
    return { ok: true, content: "", digest: null, reason: "no required skill" };
  }
  try {
    const content = await readFile(workOrder.requiredSkillPath, "utf8");
    return {
      ok: true,
      path: workOrder.requiredSkillPath,
      content,
      digest: createHash("sha256").update(content).digest("hex")
    };
  } catch (error) {
    return {
      ok: false,
      path: workOrder.requiredSkillPath,
      content: "",
      digest: null,
      reason: error.message
    };
  }
}

function buildHandoff({ turn, workOrder, prompt, repairedFromTurnId = null }) {
  const parsedRaw = parseJson(turn.finalText);
  const transcriptEvidence = extractSkillReadEvidence({
    requiredSkill: workOrder.requiredSkill,
    promptText: prompt,
    finalText: turn.finalText,
    notifications: turn.notifications
  });
  const parsed = applyTranscriptEvidence(parsedRaw, transcriptEvidence);
  const validation = validateWorkerResult(workOrder, parsed);
  const turnId = turn.completed.params?.turn?.id ?? null;
  return {
    parsed,
    validation,
    turnId,
    handoff: {
      result: parsed,
      validation,
      transcriptEvidence,
      rawFinalText: validation.ok ? undefined : turn.finalText,
      repairedFromTurnId
    }
  };
}

function isMalformedWorkerHandoff(handoff) {
  if (!handoff.parsed) return true;
  const errors = handoff.validation.errors ?? [];
  return errors.some((error) => /status must be|evidence\.skill_read|files_changed|commands_run|risks must/i.test(error));
}

function parseJson(text) {
  try {
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    const extracted = extractJsonObject(text);
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function extractJsonObject(text) {
  const match = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return match[1].trim();
  const first = String(text).indexOf("{");
  const last = String(text).lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  return String(text).slice(first, last + 1);
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function normalizeSessionRole(role) {
  const text = requiredText(role, "role");
  if (!SESSION_ROLES.includes(text)) {
    throw new Error(`Unknown session role: ${text}`);
  }
  return text;
}

function normalizeSessionSource(source) {
  const text = requiredText(source, "source");
  if (!SESSION_SOURCES.includes(text)) {
    throw new Error(`Unknown session source: ${text}`);
  }
  return text;
}

function resolveSessionTarget(state, target) {
  const exact = state.sessions[target];
  if (exact) return exact;
  const matches = Object.values(state.sessions).filter((item) => item.threadId === target);
  if (matches.length === 0) return null;
  const currentThreadId = process.env.CODEX_THREAD_ID;
  if (currentThreadId && target === currentThreadId) {
    const currentButler = matches.find((item) => item.role === "butler-controller" && item.source === "current-session");
    if (currentButler) return currentButler;
  }
  return matches.find((item) => item.role === "butler-controller") ?? matches[0];
}

function isCurrentAttachedSession(session) {
  return session?.source === "current-session"
    && session.threadId
    && process.env.CODEX_THREAD_ID === session.threadId;
}

function markSessionAttached(session) {
  return {
    ...session,
    health: {
      status: "attached",
      probedAt: new Date().toISOString(),
      turnId: null,
      error: null,
      detail: "This is the current Codex session. It can operate Butler tools here, but it is not reachable as a remote app-server worker turn."
    }
  };
}

function defaultSessionLabel(role) {
  if (role === "butler-controller") return "Butler controller";
  if (role === "worker-session") return "Managed local session";
  return role;
}

function completeGateTask(task, gate, evidence) {
  let next = task;
  if (next.state === "queued") next = transition(next, "leased", { gate });
  if (next.state === "leased") next = transition(next, "dispatched", { gate });
  if (next.state === "dispatched") next = transition(next, "awaiting_result", { gate });
  if (next.state === "awaiting_result") next = transition(next, "validating", { gate });
  if (next.state === "validating" || next.state === "review") next = transition(next, "verified", { gate });
  if (next.state === "verified") next = transition(next, "promoted", evidence);
  return next;
}

function workerPrompt(workOrder, skillSource = { ok: false }) {
  const parts = [
    "You are a Codex worker session controlled by codex-butler.",
    "Follow the work order exactly. Do not ask the user directly.",
    "The controller may load the required skill below. Follow those loaded instructions as binding task policy.",
    "Return only JSON matching the provided output schema. No Markdown, no prose, no explanation outside the JSON.",
    "If ownedScope is a worktree path, edit only inside that owned scope.",
    `Work order:\n${JSON.stringify(workOrder, null, 2)}`
  ];
  if (skillSource.ok && skillSource.content) {
    parts.push(`Controller-loaded required skill from ${skillSource.path}:\n\n${skillSource.content}`);
  } else if (workOrder.requiredSkillPath) {
    parts.push(`Required skill could not be loaded from ${workOrder.requiredSkillPath}: ${skillSource.reason ?? "unknown error"}. If this blocks the task, return status "blocked" with the reason in risks.`);
  }
  return parts.join("\n\n");
}
