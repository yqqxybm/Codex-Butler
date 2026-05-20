import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
    const prompt = workerPrompt(workOrder);
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
      const parsedRaw = parseJson(turn.finalText);
      const transcriptEvidence = extractSkillReadEvidence({
        requiredSkill: workOrder.requiredSkill,
        promptText: prompt,
        finalText: turn.finalText,
        notifications: turn.notifications
      });
      const parsed = applyTranscriptEvidence(parsedRaw, transcriptEvidence);
      const validation = validateWorkerResult(workOrder, parsed);
      task.threadId = thread.thread.id;
      task.turnId = turn.completed.params?.turn?.id ?? null;
      task.handoff = { result: parsed, validation, transcriptEvidence };
      if (parsed?.status === "blocked") {
        task = transition(task, "blocked", { validation });
      } else {
        task = transition(task, "validating", { validation });
        if (!validation.ok || parsed?.status === "needs_rework") {
          task = transition(task, "rework", { validation });
        }
      }
      state.tasks[taskId] = task;
      await this.state.save(state);
      await this.ledger.append("task.handoff_received", { taskId, threadId: task.threadId, turnId: task.turnId, validation });
      return task;
    } finally {
      client.close();
    }
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

  async status() {
    const state = await this.state.load();
    return {
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      goals: Object.values(state.goals),
      tasks: Object.values(state.tasks)
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
    .filter((id) => !["verified", "promoted"].includes(state.tasks[id]?.state));
  if (unmetPrerequisites.length > 0) {
    throw new Error(`Task ${task.id} has unmet prerequisites: ${unmetPrerequisites.join(", ")}`);
  }
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
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

function workerPrompt(workOrder) {
  return [
    "You are a Codex worker session controlled by codex-butler.",
    "Follow the work order exactly. Do not ask the user directly.",
    "If a requiredSkill is present, read that skill's SKILL.md with a tool before claiming completion.",
    "If ownedScope is a worktree path, edit only inside that owned scope.",
    "Return only JSON matching the provided output schema.",
    `Work order:\n${JSON.stringify(workOrder, null, 2)}`
  ].join("\n\n");
}
