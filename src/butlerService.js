import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventLedger } from "./ledger.js";
import { StateStore } from "./stateStore.js";
import { createGoal, createTask, transition } from "./stateMachine.js";
import { buildWorkOrder, validateWorkerResult, WORKER_OUTPUT_SCHEMA } from "./roleContracts.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import { allocateWorktree, promoteWorktree } from "./worktree.js";
import { runCommand } from "./exec.js";

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

  async createTask({ goalId, role, objective, ownedScope = this.projectRoot }) {
    const state = await this.state.load();
    const goal = state.goals[goalId];
    if (!goal) throw new Error(`Unknown goal: ${goalId}`);
    const task = createTask(`task-${randomUUID()}`, goalId, objective, role);
    task.ownedScope = ownedScope;
    state.tasks[task.id] = task;
    if (goal.state === "intake") state.goals[goalId] = transition(goal, "planned", { taskId: task.id });
    await this.state.save(state);
    await this.ledger.append("task.created", { goalId, taskId: task.id, role, objective, ownedScope });
    return state.tasks[task.id];
  }

  async dispatchTask({ taskId }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    const goal = requiredGoal(state, task.goalId);
    const workOrder = buildWorkOrder({
      role: task.ownerRole,
      taskId,
      goal: goal.objective,
      objective: task.objective,
      ownedScope: task.ownedScope
    });

    task = transition(task, "leased", { workOrder });
    task.leaseId = `lease-${randomUUID()}`;
    task = transition(task, "dispatched", { leaseId: task.leaseId });
    task = transition(task, "awaiting_result", { transport: "app-server-turn" });
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append("task.dispatched", { taskId, leaseId: task.leaseId, workOrder });

    const client = this.clientFactory();
    try {
      const thread = await client.startEphemeralThread(this.projectRoot);
      const turn = await client.startTurn({
        threadId: thread.thread.id,
        inputText: workerPrompt(workOrder),
        outputSchema: WORKER_OUTPUT_SCHEMA
      });
      const parsed = parseJson(turn.finalText);
      const validation = validateWorkerResult(workOrder, parsed);
      task.threadId = thread.thread.id;
      task.turnId = turn.completed.params?.turn?.id ?? null;
      task.handoff = { result: parsed, validation };
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

  async runVerifier({ taskId, command, cwd = null }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    if (!["validating", "review"].includes(task.state)) {
      throw new Error(`Task ${taskId} cannot be verified from state ${task.state}`);
    }
    const result = await runCommand(command[0], command.slice(1), {
      cwd: cwd ?? task.worktreePath ?? this.projectRoot,
      timeoutMs: 120000
    });
    task.verification = {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
    task = result.exitCode === 0
      ? transition(task, "verified", { command, exitCode: result.exitCode })
      : transition(task, "rework", { command, exitCode: result.exitCode });
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append(result.exitCode === 0 ? "task.verified" : "task.verification_failed", {
      taskId,
      command,
      exitCode: result.exitCode
    });
    return task;
  }

  async promoteTask({ taskId }) {
    const state = await this.state.load();
    let task = requiredTask(state, taskId);
    if (task.state !== "verified") {
      throw new Error(`Task ${taskId} must be verified before promotion`);
    }
    const result = task.worktreePath
      ? await promoteWorktree(this.projectRoot, task.worktreePath)
      : { ok: true, promoted: false, reason: "task has no worktree diff" };
    if (!result.ok) {
      await this.ledger.append("task.promotion_blocked", { taskId, result });
      return { ok: false, task, result };
    }
    task = transition(task, "promoted", result);
    state.tasks[taskId] = task;
    await this.state.save(state);
    await this.ledger.append("task.promoted", { taskId, result });
    return { ok: true, task, result };
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

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function workerPrompt(workOrder) {
  return [
    "You are a Codex worker session controlled by codex-butler.",
    "Follow the work order exactly. Do not ask the user directly.",
    "Return only JSON matching the provided output schema.",
    `Work order:\n${JSON.stringify(workOrder, null, 2)}`
  ].join("\n\n");
}
