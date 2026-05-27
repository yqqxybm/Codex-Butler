export function renderDashboard(status, events = []) {
  const goals = status.goals ?? [];
  const tasks = status.tasks ?? [];
  const sessions = status.sessions ?? [];
  const sessionRuns = status.sessionRuns ?? [];
  const activeGoals = goals.filter((goal) => !["done", "failed"].includes(goal.state));
  const doneGoals = goals.filter((goal) => goal.state === "done");
  const blockedGoals = goals.filter((goal) => goal.state === "blocked");
  const activeSessionRuns = sessionRuns.filter((run) => run.state === "active");
  const pausedSessionRuns = sessionRuns.filter((run) => ["needs_user", "blocked"].includes(run.state));
  const butlerSessions = sessions.filter((session) => session.role === "butler-controller");
  const reachableButlers = butlerSessions.filter((session) => session.health?.status === "reachable");
  const attachedButlers = butlerSessions.filter((session) => session.health?.status === "attached");
  const taskCounts = countBy(tasks, "state");
  const lines = [
    "Codex Butler Dashboard",
    `Project: ${status.projectRoot}`,
    `Data: ${status.dataDir}`,
    "",
    `Goals: ${goals.length} total, ${activeGoals.length} active, ${doneGoals.length} done, ${blockedGoals.length} blocked`,
    `Session runs: ${sessionRuns.length} total, ${activeSessionRuns.length} active, ${pausedSessionRuns.length} need attention`,
    `Tasks: ${tasks.length} total${formatTaskCounts(taskCounts)}`,
    `Sessions: ${sessions.length} managed, ${butlerSessions.length} butler, ${reachableButlers.length} reachable butler, ${attachedButlers.length} attached current-session`,
    ""
  ];

  lines.push("Active Goals");
  if (activeGoals.length === 0) lines.push("- none");
  else {
    for (const goal of activeGoals.slice(0, 8)) {
      lines.push(`- ${goal.id} [${goal.state}] ${goal.objective}`);
    }
  }

  lines.push("", "Session Runs");
  if (sessionRuns.length === 0) lines.push("- none");
  else {
    for (const run of sessionRuns.slice(0, 8)) {
      lines.push(`- ${run.id} [${run.state}] ${run.targetLabel ?? run.targetThreadId}: ${run.objective}`);
    }
  }

  lines.push("", "Active Tasks");
  const activeTasks = tasks.filter((task) => !["promoted", "failed"].includes(task.state));
  if (activeTasks.length === 0) lines.push("- none");
  else {
    for (const task of activeTasks.slice(0, 12)) {
      lines.push(`- ${task.id} [${task.state}] ${task.ownerRole}: ${task.objective}`);
    }
  }

  lines.push("", "Managed Sessions");
  if (sessions.length === 0) lines.push("- none");
  else {
    for (const session of sessions.slice(0, 10)) {
      const health = session.health?.status ? ` (${session.health.status})` : "";
      lines.push(`- ${session.id} [${session.role}]${health} ${session.label} -> ${session.threadId}`);
    }
  }

  lines.push("", "Recent Events");
  const recent = events.slice(-8).reverse();
  if (recent.length === 0) lines.push("- none");
  else {
    for (const event of recent) {
      lines.push(`- ${event.at ?? "unknown-time"} ${event.type}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function countBy(items, field) {
  const counts = {};
  for (const item of items) {
    const key = item[field] ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function formatTaskCounts(taskCounts) {
  const entries = Object.entries(taskCounts);
  if (entries.length === 0) return "";
  return ` (${entries.map(([state, count]) => `${state}: ${count}`).join(", ")})`;
}
