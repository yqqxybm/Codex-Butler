export const GOAL_STATES = Object.freeze([
  "intake",
  "planned",
  "running",
  "reviewing",
  "promoting",
  "done",
  "blocked",
  "failed"
]);

export const TASK_STATES = Object.freeze([
  "queued",
  "leased",
  "dispatched",
  "awaiting_result",
  "validating",
  "review",
  "verified",
  "promoted",
  "rework",
  "blocked",
  "failed"
]);

const GOAL_TRANSITIONS = Object.freeze({
  intake: ["planned", "blocked", "failed"],
  planned: ["running", "blocked", "failed"],
  running: ["reviewing", "blocked", "failed"],
  reviewing: ["promoting", "running", "blocked", "failed"],
  promoting: ["done", "reviewing", "blocked", "failed"],
  done: [],
  blocked: ["planned", "failed"],
  failed: []
});

const TASK_TRANSITIONS = Object.freeze({
  queued: ["leased", "blocked", "failed"],
  leased: ["dispatched", "queued", "blocked", "failed"],
  dispatched: ["awaiting_result", "blocked", "failed"],
  awaiting_result: ["validating", "blocked", "failed"],
  validating: ["review", "verified", "rework", "blocked", "failed"],
  review: ["verified", "rework", "blocked", "failed"],
  verified: ["promoted", "blocked", "failed"],
  promoted: [],
  rework: ["queued", "blocked", "failed"],
  blocked: ["queued", "failed"],
  failed: []
});

export function createGoal(id, objective) {
  return {
    kind: "goal",
    id,
    objective,
    state: "intake",
    history: []
  };
}

export function createTask(id, goalId, objective, ownerRole) {
  return {
    kind: "task",
    id,
    goalId,
    objective,
    ownerRole,
    state: "queued",
    leaseId: null,
    history: []
  };
}

export function transition(entity, nextState, evidence = {}) {
  const transitions = entity.kind === "goal" ? GOAL_TRANSITIONS : TASK_TRANSITIONS;
  const allowed = transitions[entity.state] ?? [];
  if (!allowed.includes(nextState)) {
    throw new Error(`Invalid ${entity.kind} transition: ${entity.state} -> ${nextState}`);
  }
  const event = {
    from: entity.state,
    to: nextState,
    at: new Date().toISOString(),
    evidence
  };
  return {
    ...entity,
    state: nextState,
    history: [...entity.history, event]
  };
}

export function isTerminal(entity) {
  const transitions = entity.kind === "goal" ? GOAL_TRANSITIONS : TASK_TRANSITIONS;
  return (transitions[entity.state] ?? []).length === 0;
}
