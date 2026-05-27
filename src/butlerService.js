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
import { CodexExecClient } from "./codexExecClient.js";
import { SessionDetailReader } from "./sessionDetails.js";

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

const WORKER_TURN_TIMEOUT_MS = 180000;
const STALE_WORKER_TASK_MS = WORKER_TURN_TIMEOUT_MS + 60000;
const IN_FLIGHT_TASK_STATES = Object.freeze(["leased", "dispatched", "awaiting_result"]);
const SESSION_RUN_COOLDOWN_MS = 15000;
const SESSION_RUN_IN_FLIGHT_MS = 600000;

export class ButlerService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.dataDir = options.dataDir ?? join(this.projectRoot, ".codex-butler");
    this.state = new StateStore(options.statePath ?? join(this.dataDir, "state.json"));
    this.ledger = new EventLedger(options.ledgerPath ?? join(this.dataDir, "events.jsonl"));
    this.clientFactory = options.clientFactory ?? (() => new CodexAppServerClient({ cwd: this.projectRoot }));
    this.execClientFactory = options.execClientFactory ?? (() => new CodexExecClient({
      cwd: this.projectRoot,
      dataDir: this.dataDir
    }));
    this.sessionDetailReader = options.sessionDetailReader ?? new SessionDetailReader(options.sessionDetailOptions);
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

  async startSessionRun({ sessionIdOrThreadId, objective = null, maxTurns = 3 }) {
    const target = requiredText(sessionIdOrThreadId, "sessionIdOrThreadId");
    const state = await this.state.load();
    const session = resolveSessionTarget(state, target);
    if (!session) throw new Error(`Unknown session: ${target}`);
    const now = new Date().toISOString();
    const run = {
      kind: "session-run",
      id: `session-run-${randomUUID()}`,
      targetSessionId: session.id,
      targetThreadId: session.threadId,
      targetLabel: session.label,
      targetSource: session.source,
      objective: optionalText(objective) ?? "沿着这个 Codex session 已有上下文继续推进，直到完成或需要用户做选择。",
      state: "active",
      mode: "codex-exec-resume",
      createdAt: now,
      updatedAt: now,
      nextCheckAt: new Date(Date.now() + SESSION_RUN_IN_FLIGHT_MS).toISOString(),
      turns: [],
      notes: []
    };
    state.sessionRuns[run.id] = run;
    await this.state.save(state);
    await this.ledger.append("session_run.started", {
      runId: run.id,
      targetSessionId: run.targetSessionId,
      targetThreadId: run.targetThreadId,
      objective: run.objective
    });
    return this.advanceSessionRun({ runId: run.id, maxTurns });
  }

  async advanceSessionRun({ runId, maxTurns = 3, note = null }) {
    const normalizedRunId = requiredText(runId, "runId");
    const stepLimit = Math.max(1, Math.min(Number(maxTurns) || 1, 20));
    let state = await this.state.load();
    let run = requiredSessionRun(state, normalizedRunId);
    const noteText = optionalText(note);
    if (noteText) {
      run = {
        ...run,
        state: "active",
        pendingUserDecision: null,
        notes: [
          ...(run.notes ?? []),
          {
            at: new Date().toISOString(),
            source: "user-decision",
            note: noteText
          }
        ],
        updatedAt: new Date().toISOString(),
        nextCheckAt: new Date().toISOString()
      };
      state.sessionRuns[run.id] = run;
      await this.state.save(state);
      await this.ledger.append("session_run.resumed", { runId: run.id, note: noteText });
    } else if (run.state === "blocked") {
      run = {
        ...run,
        state: "active",
        blockedReason: null,
        updatedAt: new Date().toISOString(),
        nextCheckAt: new Date().toISOString()
      };
      state.sessionRuns[run.id] = run;
      await this.state.save(state);
      await this.ledger.append("session_run.retried", { runId: run.id });
    } else if (!["active"].includes(run.state)) {
      return {
        ok: run.state === "done",
        run,
        actions: [{
          action: "noop",
          ok: run.state === "done",
          reason: sessionRunStateMessage(run)
        }]
      };
    }

    run = {
      ...run,
      nextCheckAt: new Date(Date.now() + SESSION_RUN_IN_FLIGHT_MS).toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.sessionRuns[run.id] = run;
    await this.state.save(state);

    const actions = [];
    for (let index = 0; index < stepLimit; index += 1) {
      state = await this.state.load();
      run = requiredSessionRun(state, normalizedRunId);
      if (run.state !== "active") break;

      const turnIndex = (run.turns ?? []).length + 1;
      const client = this.execClientFactory();
      const prompt = sessionRunPrompt(run, { note: noteText, turnIndex });
      const result = await client.resumeSession({
        sessionId: run.targetThreadId,
        prompt,
        runId: run.id,
        turnIndex
      });
      const parsed = normalizeSessionRunResult(result.parsed);
      const turnRecord = {
        at: new Date().toISOString(),
        turnIndex,
        exitCode: result.exitCode,
        timedOut: result.timedOut === true,
        outputPath: result.outputPath ?? null,
        status: parsed?.status ?? null,
        summary: parsed?.summary ?? null,
        userDecision: parsed?.user_decision ?? null,
        actions: parsed?.actions ?? [],
        risks: parsed?.risks ?? []
      };

      run = {
        ...run,
        turns: [...(run.turns ?? []), turnRecord],
        updatedAt: turnRecord.at
      };

      if (result.exitCode !== 0 || !parsed) {
        run.state = "blocked";
        run.blockedReason = result.timedOut
          ? "选中的 session 本轮执行超时，需要重新推进或人工检查。"
          : result.stderr || result.stdout || "选中的 session 没有返回合格的结构化结果。";
        run.nextCheckAt = null;
      } else if (parsed.status === "needs_user") {
        run.state = "needs_user";
        run.pendingUserDecision = parsed.user_decision || "需要你做一个选择后才能继续。";
        run.nextCheckAt = null;
      } else if (parsed.status === "done") {
        run.state = "done";
        run.completedAt = turnRecord.at;
        run.nextCheckAt = null;
      } else if (parsed.status === "blocked") {
        run.state = "blocked";
        run.blockedReason = parsed.summary || parsed.risks?.[0] || "选中的 session 报告无法继续。";
        run.nextCheckAt = null;
      } else {
        run.state = "active";
        run.nextCheckAt = new Date(Date.now() + SESSION_RUN_COOLDOWN_MS).toISOString();
      }

      state.sessionRuns[run.id] = run;
      await this.state.save(state);
      await this.ledger.append("session_run.turn", {
        runId: run.id,
        targetThreadId: run.targetThreadId,
        turnIndex,
        state: run.state,
        exitCode: result.exitCode
      });
      actions.push({
        action: "session-turn",
        ok: result.exitCode === 0 && Boolean(parsed),
        runId: run.id,
        state: run.state,
        status: parsed?.status ?? null,
        summary: parsed?.summary ?? run.blockedReason ?? null
      });

      if (run.state !== "active") break;
    }

    state = await this.state.load();
    run = requiredSessionRun(state, normalizedRunId);
    return {
      ok: !["blocked", "failed"].includes(run.state),
      run,
      actions,
      progress: describeSessionRunProgress(run)
    };
  }

  async resumeSessionRun({ runId, note, maxTurns = 3 }) {
    return this.advanceSessionRun({ runId, note: requiredText(note, "note"), maxTurns });
  }

  async advanceActiveSessionRuns({ maxRuns = 2, maxTurns = 1 } = {}) {
    const state = await this.state.load();
    const now = Date.now();
    const runs = Object.values(state.sessionRuns)
      .filter((run) => run.state === "active")
      .filter((run) => !run.nextCheckAt || new Date(run.nextCheckAt).getTime() <= now)
      .slice(0, Math.max(1, Number(maxRuns) || 1));
    const results = [];
    for (const run of runs) {
      results.push(await this.advanceSessionRun({ runId: run.id, maxTurns }));
    }
    return {
      ok: results.every((result) => result.ok !== false),
      advanced: results.length,
      results
    };
  }

  async advanceGoal({ goalId, maxSteps = 1 }) {
    const normalizedGoalId = requiredText(goalId, "goalId");
    const stepLimit = Math.max(1, Math.min(Number(maxSteps) || 1, 20));
    const actions = [];

    for (let index = 0; index < stepLimit; index += 1) {
      await this.reconcileStaleTasks();
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
      targetTaskId: task.targetTaskId,
      contextNotes: task.contextNotes ?? []
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
      task.threadId = thread.thread.id;
      await this.updateLeasedTaskFields(taskId, task.leaseId, { threadId: task.threadId });
      const turn = await client.startTurn({
        threadId: thread.thread.id,
        inputText: prompt,
        outputSchema: WORKER_OUTPUT_SCHEMA,
        cwd: workerCwd,
        sandboxPolicy,
        onStarted: async (start) => {
          task.turnId = start.turn?.id ?? null;
          if (task.turnId) {
            await this.updateLeasedTaskFields(taskId, task.leaseId, { turnId: task.turnId });
          }
        }
      });
      const handoff = await this.parseWorkerHandoff({ turn, workOrder, prompt, client, threadId: thread.thread.id, workerCwd, sandboxPolicy });
      const latestState = await this.state.load();
      const currentTask = latestState.tasks[taskId];
      if (!isSameActiveLease(currentTask, task.leaseId)) {
        return currentTask;
      }
      task = {
        ...currentTask,
        threadId: thread.thread.id
      };
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
      latestState.tasks[taskId] = task;
      await this.state.save(latestState);
      await this.ledger.append("task.handoff_received", { taskId, threadId: task.threadId, turnId: task.turnId, validation: handoff.validation });
      return task;
    } catch (error) {
      return await this.blockWorkerDispatch({
        taskId,
        leaseId: task.leaseId,
        error,
        threadId: task.threadId ?? null,
        turnId: task.turnId ?? null,
        source: "worker-turn-failed"
      });
    } finally {
      client.close();
    }
  }

  async updateLeasedTaskFields(taskId, leaseId, fields) {
    const state = await this.state.load();
    const task = state.tasks[taskId];
    if (!isSameActiveLease(task, leaseId)) return false;
    state.tasks[taskId] = { ...task, ...fields };
    await this.state.save(state);
    return true;
  }

  async blockWorkerDispatch({ taskId, leaseId, error, threadId = null, turnId = null, source = "worker-turn-failed" }) {
    const state = await this.state.load();
    let task = state.tasks[taskId];
    if (!isSameActiveLease(task, leaseId)) return task;
    const message = error?.message ?? String(error);
    task = {
      ...task,
      threadId: threadId ?? task.threadId ?? null,
      turnId: turnId ?? task.turnId ?? null,
      handoff: workerFailureHandoff({
        summary: "执行会话没有正常返回，可以重新跑这一步。",
        risk: message
      })
    };
    task = transition(task, "blocked", { source, error: message });
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append("task.dispatch_failed", { taskId, leaseId, source, error: message });
    await this.refreshGoalState(task.goalId);
    return task;
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

  async resumeBlockedTask({ taskId, note, source = "user-calibration" }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    if (task.state !== "blocked") {
      throw new Error(`Task ${taskId} cannot be resumed from state ${task.state}`);
    }
    const text = requiredText(note, "note");
    const previousState = task.state;
    const contextNote = {
      at: new Date().toISOString(),
      source,
      note: text
    };
    task = transition(task, "queued", { source, previousState, note: text });
    task.leaseId = null;
    task.contextNotes = [...(task.contextNotes ?? []), contextNote];
    delete task.threadId;
    delete task.turnId;
    delete task.handoff;
    delete task.verification;
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append("task.resumed", { taskId, previousState, source, note: text });
    await this.refreshGoalState(task.goalId);
    return task;
  }

  async reconcileStaleTasks({ maxAgeMs = STALE_WORKER_TASK_MS } = {}) {
    const state = await this.state.load();
    const now = Date.now();
    const staleTasks = [];
    for (const task of Object.values(state.tasks)) {
      if (!IN_FLIGHT_TASK_STATES.includes(task.state)) continue;
      const startedAt = latestStateEnteredAt(task, task.state);
      if (!startedAt) continue;
      const elapsedMs = now - startedAt.getTime();
      if (elapsedMs < maxAgeMs) continue;
      const summary = `执行会话超过 ${formatDuration(maxAgeMs)} 没有返回，可以重新跑这一步。`;
      let next = {
        ...task,
        handoff: workerFailureHandoff({
          summary,
          risk: `No worker handoff was received after ${formatDuration(elapsedMs)}. The dispatch process may have exited or lost its app-server turn.`
        })
      };
      next = transition(next, "blocked", {
        source: "stale-worker-watchdog",
        elapsedMs,
        maxAgeMs
      });
      state.tasks[task.id] = next;
      staleTasks.push(next);
    }
    if (staleTasks.length === 0) {
      return { ok: true, stale: 0, tasks: [] };
    }
    await this.state.save(state);
    for (const task of staleTasks) {
      await this.ledger.append("task.stale_blocked", {
        taskId: task.id,
        leaseId: task.leaseId,
        state: task.state,
        threadId: task.threadId ?? null,
        turnId: task.turnId ?? null
      });
      await this.refreshGoalState(task.goalId);
    }
    return { ok: true, stale: staleTasks.length, tasks: staleTasks };
  }

  async status() {
    await this.reconcileStaleTasks();
    const state = await this.state.load();
    const sessions = await this.sessionDetailReader.enrichSessions(Object.values(state.sessions));
    return {
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      goals: Object.values(state.goals),
      tasks: Object.values(state.tasks),
      sessions,
      sessionRuns: Object.values(state.sessionRuns)
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
      sessionRunProgress: Object.fromEntries(status.sessionRuns.map((run) => [
        run.id,
        describeSessionRunProgress(run)
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

function requiredSessionRun(state, runId) {
  const run = state.sessionRuns[runId];
  if (!run) throw new Error(`Unknown session run: ${runId}`);
  return run;
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
    const message = stalled.state === "blocked" && recoverable
      ? `自动推进已暂停：执行会话没有正常返回，可以重新跑这一步${details[0] ? `，${details[0]}` : "。"}`
      : stalled.state === "blocked"
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
    ? [`${task.handoff?.recoverable ? "可重跑" : "需要确认"}：${task.handoff.result.summary}`]
    : [];
  const details = [...blockedSummary, ...validationErrors];
  if (task.verification?.exitCode && task.verification.exitCode !== 0) {
    details.push(`verification command exited ${task.verification.exitCode}: ${task.verification.command?.join(" ") ?? "unknown command"}`);
  }
  for (const risk of risks) details.push(`risk: ${risk}`);
  return details;
}

function describeSessionRunProgress(run) {
  const lastTurn = run.turns?.at?.(-1) ?? null;
  if (run.state === "done") {
    return {
      status: "complete",
      message: "这个 session 已经推进到完成。",
      needsUser: false,
      lastSummary: lastTurn?.summary ?? null,
      details: []
    };
  }
  if (run.state === "needs_user") {
    return {
      status: "needs_user",
      message: run.pendingUserDecision || "需要你做一个选择后才能继续。",
      needsUser: true,
      lastSummary: lastTurn?.summary ?? null,
      details: []
    };
  }
  if (run.state === "blocked") {
    return {
      status: "blocked",
      message: run.blockedReason || "管家无法继续推进这个 session。",
      needsUser: true,
      lastSummary: lastTurn?.summary ?? null,
      details: lastTurn?.risks ?? []
    };
  }
  return {
    status: "active",
    message: "管家正在持续推进这个 session。",
    needsUser: false,
    lastSummary: lastTurn?.summary ?? null,
    nextCheckAt: run.nextCheckAt ?? null,
    details: []
  };
}

function sessionRunStateMessage(run) {
  if (run.state === "done") return "这个 session run 已完成。";
  if (run.state === "needs_user") return run.pendingUserDecision || "需要用户选择。";
  if (run.state === "blocked") return run.blockedReason || "这个 session run 已阻塞。";
  return "这个 session run 当前不可推进。";
}

function normalizeSessionRunResult(result) {
  if (!result || typeof result !== "object") return null;
  if (!["in_progress", "needs_user", "done", "blocked"].includes(result.status)) return null;
  if (typeof result.summary !== "string") return null;
  if (typeof result.user_decision !== "string") return null;
  if (!Array.isArray(result.actions)) return null;
  if (!Array.isArray(result.risks)) return null;
  return result;
}

function isRecoverableTask(task) {
  if (!task) return false;
  if (task.state === "blocked" && task.handoff?.recoverable === true) return true;
  if (task.state !== "rework") return false;
  const errors = taskIssueDetails(task);
  return errors.some((error) => /status must be|evidence\.skill_read|files_changed|commands_run|risks must|externally verified|timed out|没有正常返回|没有返回|stale/i.test(error));
}

function autoRecoverCount(task) {
  return (task?.history ?? []).filter((event) => ["rework", "blocked"].includes(event.from)
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

function isSameActiveLease(task, leaseId) {
  return task?.leaseId === leaseId && IN_FLIGHT_TASK_STATES.includes(task.state);
}

function latestStateEnteredAt(task, state) {
  for (const event of [...(task.history ?? [])].reverse()) {
    if (event.to === state && event.at) return new Date(event.at);
  }
  return null;
}

function workerFailureHandoff({ summary, risk }) {
  return {
    result: {
      status: "blocked",
      summary,
      evidence: { skill_read: "declared", files_changed: [], commands_run: [] },
      risks: [risk]
    },
    validation: { ok: true, errors: [] },
    recoverable: true
  };
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `${minutes} 分钟`;
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

function sessionRunPrompt(run, { note = null, turnIndex = 1 } = {}) {
  const recentTurns = (run.turns ?? []).slice(-4).map((turn) => ({
    turnIndex: turn.turnIndex,
    status: turn.status,
    summary: turn.summary,
    userDecision: turn.userDecision,
    actions: turn.actions,
    risks: turn.risks
  }));
  const notes = (run.notes ?? []).slice(-4);
  return [
    "You are a Codex work session selected by Codex Butler for supervised auto-advance.",
    "Continue the current task in this session toward the user's existing goal. Make concrete progress instead of reporting status only.",
    "If the next step is clear, execute it. If code/doc/config changes are needed, make them and verify them according to the session's instructions.",
    "Stop only when the goal is complete, a genuine user choice is required, or a real blocker prevents progress.",
    "Return JSON only matching this schema: {\"status\":\"in_progress|needs_user|done|blocked\",\"summary\":\"...\",\"user_decision\":\"...\",\"actions\":[\"...\"],\"risks\":[\"...\"]}.",
    "Use status \"needs_user\" only when the user must choose between materially different paths. Put the exact concise question in user_decision.",
    "Use status \"done\" only when the target is actually achieved and verified. Use status \"in_progress\" if you made progress and Butler should continue.",
    `Butler objective: ${run.objective}`,
    `Target session: ${run.targetLabel ?? run.targetThreadId} (${run.targetThreadId})`,
    `Butler run id: ${run.id}; turn: ${turnIndex}`,
    note ? `Latest user decision: ${note}` : null,
    notes.length > 0 ? `Prior user decisions:\n${JSON.stringify(notes, null, 2)}` : null,
    recentTurns.length > 0 ? `Recent Butler tracking turns:\n${JSON.stringify(recentTurns, null, 2)}` : null
  ].filter(Boolean).join("\n\n");
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
