const state = {
  dashboard: null,
  busy: false
};

const elements = {
  plannerForm: document.querySelector("#plannerForm"),
  sessionForm: document.querySelector("#sessionForm"),
  objectiveInput: document.querySelector("#objectiveInput"),
  sessionThreadInput: document.querySelector("#sessionThreadInput"),
  sessionLabelInput: document.querySelector("#sessionLabelInput"),
  formHelp: document.querySelector("#formHelp"),
  sessionHelp: document.querySelector("#sessionHelp"),
  refreshButton: document.querySelector("#refreshButton"),
  startDaemonButton: document.querySelector("#startDaemonButton"),
  stopDaemonButton: document.querySelector("#stopDaemonButton"),
  probeAllButton: document.querySelector("#probeAllButton"),
  daemonTile: document.querySelector("#daemonTile"),
  readinessTitle: document.querySelector("#readinessTitle"),
  readinessText: document.querySelector("#readinessText"),
  goalCount: document.querySelector("#goalCount"),
  activeGoalCount: document.querySelector("#activeGoalCount"),
  taskCount: document.querySelector("#taskCount"),
  queuedTaskCount: document.querySelector("#queuedTaskCount"),
  blockedCount: document.querySelector("#blockedCount"),
  sessionCount: document.querySelector("#sessionCount"),
  butlerSessionCount: document.querySelector("#butlerSessionCount"),
  goalsList: document.querySelector("#goalsList"),
  sessionsList: document.querySelector("#sessionsList"),
  taskTable: document.querySelector("#taskTable"),
  eventLog: document.querySelector("#eventLog"),
  toast: document.querySelector("#toast")
};

elements.plannerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const objective = elements.objectiveInput.value.trim();
  if (!objective) return;
  const mode = event.submitter?.dataset?.planMode ?? "run";
  const path = mode === "plan" ? "/api/goals/plan" : "/api/goals/plan-and-run";
  await runAction(mode === "plan" ? "计划已生成" : "计划已生成，并已推进第一步", () => api(path, {
    method: "POST",
    body: JSON.stringify({ objective, maxSteps: 1 })
  }), {
    button: event.submitter,
    pendingMessage: mode === "plan" ? "正在生成计划..." : "正在生成计划并推进第一步，可能需要几十秒..."
  });
  elements.objectiveInput.value = "";
  await refresh();
});

elements.sessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const threadId = elements.sessionThreadInput.value.trim();
  const label = elements.sessionLabelInput.value.trim();
  if (!threadId) return;
  await runAction("管家会话已添加", () => api("/api/sessions/butler", {
    method: "POST",
    body: JSON.stringify({ threadId, label: label || null })
  }));
  elements.sessionThreadInput.value = "";
  elements.sessionLabelInput.value = "";
  await refresh();
});

elements.refreshButton.addEventListener("click", () => refresh());
elements.startDaemonButton.addEventListener("click", () => runAction("后台已启动", () => api("/api/daemon/start")).then(refresh));
elements.stopDaemonButton.addEventListener("click", () => runAction("后台已停止", () => api("/api/daemon/stop")).then(refresh));
elements.probeAllButton.addEventListener("click", () => runAction("会话检查完成", () => api("/api/sessions/probe-all")).then(refresh));

elements.goalsList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-goal-action]");
  if (!button) return;
  const goalId = button.dataset.goalId;
  const maxSteps = Number(button.dataset.maxSteps ?? 1);
  await runAction(maxSteps > 1 ? "已自动推进到当前边界" : "已推进下一步", () => api(`/api/goals/${encodeURIComponent(goalId)}/advance`, {
    body: JSON.stringify({ maxSteps })
  }), {
    button,
    pendingMessage: maxSteps > 1
      ? "正在自动推进；会一直运行到完成、阻塞或需要返工。"
      : "正在推进下一步..."
  });
  await refresh();
});

elements.taskTable.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const taskId = button.dataset.taskId;
  const action = button.dataset.action;
  const labels = {
    "allocate-worktree": "工作区已准备",
    dispatch: "任务已派发",
    verify: "验证已完成",
    promote: "提升已完成",
    retry: "任务已重新排队"
  };
  await runAction(labels[action] ?? "任务已更新", () => api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`), {
    button,
    pendingMessage: action === "retry" ? "正在把任务放回待执行队列..." : "正在执行任务操作..."
  });
  await refresh();
});

elements.sessionsList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-session-action]");
  if (!button) return;
  const sessionId = button.dataset.sessionId;
  await runAction("会话已检查", () => api(`/api/sessions/${encodeURIComponent(sessionId)}/probe`));
  await refresh();
});

await refresh();
setInterval(refresh, 5000);

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    state.dashboard = await api("/api/dashboard", { method: "GET" });
    render(state.dashboard);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
  }
}

async function runAction(successMessage, fn, options = {}) {
  const button = options.button ?? null;
  const previousText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "处理中...";
  }
  if (options.pendingMessage) showToast(options.pendingMessage, false, 30000);
  try {
    const result = await fn();
    const stoppedMessage = stoppedResultMessage(result);
    if (stoppedMessage) {
      showToast(stoppedMessage, true, 9000);
    } else {
      showToast(successMessage);
    }
    return result;
  } catch (error) {
    showToast(error.message, true, 9000);
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: "POST",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function render(data) {
  const goals = data.status.goals ?? [];
  const tasks = data.status.tasks ?? [];
  const sessions = data.status.sessions ?? [];
  const events = data.recentEvents ?? [];
  const activeGoals = goals.filter((goal) => !["done", "failed"].includes(goal.state));
  const queuedTasks = tasks.filter((task) => task.state === "queued");
  const blocked = [
    ...goals.filter((goal) => goal.state === "blocked"),
    ...tasks.filter((task) => task.state === "blocked")
  ];
  const butlerSessions = sessions.filter((session) => session.role === "butler-controller");
  const usableSessions = sessions.filter((session) => ["reachable", "attached"].includes(session.health?.status));
  const reachableSessions = sessions.filter((session) => session.health?.status === "reachable");
  const attachedSessions = sessions.filter((session) => session.health?.status === "attached");
  const unreachableSessions = sessions.filter((session) => session.health?.status === "unreachable");

  elements.goalCount.textContent = goals.length;
  elements.activeGoalCount.textContent = `${activeGoals.length} 个进行中`;
  elements.taskCount.textContent = tasks.length;
  elements.queuedTaskCount.textContent = `${queuedTasks.length} 个待执行`;
  elements.blockedCount.textContent = blocked.length;
  elements.sessionCount.textContent = sessions.length;
  elements.butlerSessionCount.textContent = `${usableSessions.length} 可用，${butlerSessions.length} 个管家，${unreachableSessions.length} 个不可达`;
  renderReadiness(sessions, usableSessions, attachedSessions, unreachableSessions, data.daemon);
  renderDaemon(data.daemon);
  renderGoals(goals, data.goalProgress ?? {});
  renderSessions(sessions);
  renderTasks(tasks);
  renderEvents(events);
}

function renderDaemon(daemon) {
  const status = daemon?.status ?? "unknown";
  elements.daemonTile.innerHTML = `
    <span class="status-dot ${classForState(status)}" aria-hidden="true"></span>
    <span>后台 ${escapeHtml(status)}${daemon?.pid ? ` · pid ${daemon.pid}` : ""}</span>
  `;
}

function renderReadiness(sessions, usableSessions, attachedSessions, unreachableSessions, daemon) {
  if (daemon?.status === "running") {
    elements.readinessTitle.textContent = "后台运行中";
    if (sessions.length === 0) {
      elements.readinessText.textContent = "可以输入目标开始推进；添加已有 session 只用于复用或排障。";
    } else {
      elements.readinessText.textContent = `已登记 ${sessions.length} 个 session，${usableSessions.length} 个当前可复用，${unreachableSessions.length} 个不可达。`;
    }
    return;
  }
  if (sessions.length === 0) {
    elements.readinessTitle.textContent = "还没有会话";
    elements.readinessText.textContent = "先启动后台；已有 session 可以登记后检查可复用性。";
    return;
  }
  if (usableSessions.length > 0) {
    elements.readinessTitle.textContent = `${usableSessions.length} 个会话可用`;
    if (attachedSessions.length > 0 && unreachableSessions.length > 0) {
      elements.readinessText.textContent = `${attachedSessions.length} 个当前管家已附着，${unreachableSessions.length} 个会话不可达。`;
    } else if (attachedSessions.length > 0) {
      elements.readinessText.textContent = "当前 Codex 会话已作为管家附着，可以在这里操作 Butler。";
    } else {
      elements.readinessText.textContent = "transport 会话检查正常，可以参与后续调度。";
    }
    return;
  }
  elements.readinessTitle.textContent = "没有可用会话";
  elements.readinessText.textContent = unreachableSessions.length > 0
    ? "所有已检查会话都不可达；不能把它们当作可调度 session。"
    : "已登记会话尚未检查；点击“检查全部会话”。";
}

function renderGoals(goals, goalProgress) {
  if (goals.length === 0) {
    elements.goalsList.innerHTML = `<div class="empty-state">还没有目标。输入目标后，Butler 会生成任务并给出下一步动作。</div>`;
    return;
  }
  elements.goalsList.innerHTML = goals.map((goal) => `
    <article class="goal-item">
      <div class="item-meta">
        <span class="pill ${classForState(goal.state)}">${escapeHtml(goal.state)}</span>
        <span class="pill">${escapeHtml(shortId(goal.id))}</span>
      </div>
      <p class="item-title">${escapeHtml(goal.objective)}</p>
      <p class="item-subtitle">${goal.history?.length ?? 0} 条状态记录</p>
      ${renderGoalDiagnosis(goalProgress[goal.id])}
      <div class="row-actions">
        <button class="mini-button primary-mini" data-goal-action="advance" data-goal-id="${escapeHtml(goal.id)}" data-max-steps="1">继续推进</button>
        <button class="mini-button" data-goal-action="advance" data-goal-id="${escapeHtml(goal.id)}" data-max-steps="20">自动推进</button>
      </div>
    </article>
  `).join("");
}

function renderSessions(sessions) {
  if (sessions.length === 0) {
    elements.sessionsList.innerHTML = `<div class="empty-state">还没有登记会话。粘贴一个本地 Codex session/thread id 后再检查可达性。</div>`;
    return;
  }
  elements.sessionsList.innerHTML = sessions.map((session) => `
    <article class="goal-item">
      <div class="item-meta">
        <span class="pill ${session.role === "butler-controller" ? "good" : ""}">${escapeHtml(session.role)}</span>
        <span class="pill">${escapeHtml(session.source)}</span>
        <span class="pill">${escapeHtml(shortId(session.id))}</span>
      </div>
      <p class="item-title">${escapeHtml(session.label)}</p>
      <p class="item-subtitle">${escapeHtml(session.threadId)}${session.health ? ` · ${escapeHtml(session.health.status)}` : ""}${session.cwd ? ` · ${escapeHtml(session.cwd)}` : ""}</p>
      <div class="row-actions">
        <button class="mini-button" data-session-action="probe" data-session-id="${escapeHtml(session.id)}">检查</button>
      </div>
    </article>
  `).join("");
}

function renderTasks(tasks) {
  if (tasks.length === 0) {
    elements.taskTable.innerHTML = `<div class="empty-state">还没有任务。目标生成后，这里会显示实现、审查、验证和提升步骤。</div>`;
    return;
  }
  elements.taskTable.innerHTML = tasks.map((task) => `
    <article class="task-row">
      <div>
        <div class="item-meta">
          <span class="pill ${classForState(task.state)}">${escapeHtml(task.state)}</span>
          <span class="pill">${escapeHtml(task.ownerRole)}</span>
          <span class="pill">${escapeHtml(shortId(task.id))}</span>
        </div>
        <p class="item-title">${escapeHtml(task.objective)}</p>
        <p class="item-subtitle">${task.targetTaskId ? `目标 ${shortId(task.targetTaskId)}` : "直接任务"}${taskUsesWorktree(task) && task.worktreePath ? " · 工作区已准备" : ""}</p>
        ${renderTaskIssue(task)}
      </div>
      ${renderTaskActions(task)}
    </article>
  `).join("");
}

function renderGoalDiagnosis(progress) {
  if (!progress) return "";
  const tone = progress.status === "stalled" ? "bad" : progress.status === "complete" ? "good" : "warn";
  const details = (progress.details ?? []).slice(0, 3);
  return `
    <div class="diagnosis ${tone}">
      <strong>${escapeHtml(progress.message)}</strong>
      ${details.length > 1 ? `<ul>${details.slice(1).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : ""}
    </div>
  `;
}

function renderTaskIssue(task) {
  if (!["rework", "blocked", "failed"].includes(task.state)) return "";
  const details = taskIssueDetails(task).slice(0, 4);
  if (details.length === 0) {
    return `<div class="diagnosis bad"><strong>任务已停止，需要人工处理或重试。</strong></div>`;
  }
  return `
    <div class="diagnosis bad">
      <strong>${escapeHtml(details[0])}</strong>
      ${details.length > 1 ? `<ul>${details.slice(1).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : ""}
    </div>
  `;
}

function renderTaskActions(task) {
  const buttons = [];
  if (["rework", "blocked"].includes(task.state)) {
    buttons.push(taskButton(task, "retry", "重试", true));
  } else if (task.state === "queued") {
    if (taskUsesWorktree(task) && !task.worktreePath) {
      buttons.push(taskButton(task, "allocate-worktree", "准备工作区"));
    }
    if (!["verifier", "promoter"].includes(task.ownerRole)) {
      buttons.push(taskButton(task, "dispatch", "派发"));
    }
    if (task.ownerRole === "verifier") {
      buttons.push(taskButton(task, "verify", "验证", true));
    }
    if (task.ownerRole === "promoter") {
      buttons.push(taskButton(task, "promote", "提升", true));
    }
  } else if (["validating", "review"].includes(task.state)) {
    buttons.push(taskButton(task, "verify", "验证", true));
  } else if (task.state === "verified") {
    buttons.push(taskButton(task, "promote", "提升", true));
  }

  if (buttons.length === 0) {
    return `<div class="row-actions"><span class="inline-note">由目标卡片自动推进</span></div>`;
  }
  return `<div class="row-actions">${buttons.join("")}</div>`;
}

function taskButton(task, action, label, primary = false) {
  return `<button class="mini-button ${primary ? "primary-mini" : ""}" data-action="${escapeHtml(action)}" data-task-id="${escapeHtml(task.id)}">${escapeHtml(label)}</button>`;
}

function taskUsesWorktree(task) {
  return ["iteration-worker", "refine-worker"].includes(task.ownerRole);
}

function renderEvents(events) {
  if (events.length === 0) {
    elements.eventLog.innerHTML = `<div class="empty-state">还没有事件记录。</div>`;
    return;
  }
  elements.eventLog.innerHTML = events.slice().reverse().map((event) => `
    <article class="event-item">
      <span>${escapeHtml(formatTime(event.at))}</span>
      <strong>${escapeHtml(event.type)}</strong>
    </article>
  `).join("");
}

function classForState(state) {
  if (["attached", "running", "planned", "validating", "verified", "promoted"].includes(state)) return "good";
  if (["queued", "stopped", "intake", "review"].includes(state)) return "warn";
  if (["blocked", "failed", "rework", "stale"].includes(state)) return "bad";
  return "neutral";
}

function shortId(id) {
  return String(id).replace(/^(goal|task)-/, "").slice(0, 8);
}

function formatTime(value) {
  if (!value) return "unknown";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function stoppedResultMessage(result) {
  const target = result?.advanced ?? result;
  if (!target || target.ok !== false) return null;
  return target.progress?.message
    ?? target.actions?.at?.(-1)?.progress?.message
    ?? target.actions?.at?.(-1)?.reason
    ?? "已停止：没有可执行的下一步。";
}

function taskIssueDetails(task) {
  const validationErrors = task.handoff?.validation?.errors ?? latestHistoryValidationErrors(task);
  const risks = Array.isArray(task.handoff?.result?.risks) ? task.handoff.result.risks.map((risk) => `risk: ${risk}`) : [];
  const verification = task.verification?.exitCode
    ? [`verification command exited ${task.verification.exitCode}: ${(task.verification.command ?? []).join(" ")}`]
    : [];
  return [...validationErrors, ...verification, ...risks];
}

function latestHistoryValidationErrors(task) {
  for (const event of [...(task.history ?? [])].reverse()) {
    const errors = event.evidence?.validation?.errors;
    if (Array.isArray(errors) && errors.length > 0) return errors;
  }
  return [];
}

function showToast(message, isError = false, durationMs = 2800) {
  elements.toast.textContent = message;
  elements.toast.style.borderColor = isError ? "rgba(162, 51, 45, 0.64)" : "rgba(244, 240, 232, 0.18)";
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("visible"), durationMs);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
