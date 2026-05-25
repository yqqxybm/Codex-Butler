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
  await runAction(mode === "plan" ? "计划已生成" : "管家已接管目标，并推进到当前边界", () => api(path, {
    method: "POST",
    body: JSON.stringify({ objective, maxSteps: mode === "plan" ? 1 : 20 })
  }), {
    button: event.submitter,
    pendingMessage: mode === "plan"
      ? "正在生成计划..."
      : "管家正在建立执行链并推进；会运行到完成、明确阻塞或需要确认的边界。"
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
  await runAction(maxSteps > 1 ? "管家已推进到当前边界" : "管家已推进下一步", () => api(`/api/goals/${encodeURIComponent(goalId)}/advance`, {
    body: JSON.stringify({ maxSteps })
  }), {
    button,
    pendingMessage: maxSteps > 1
      ? "管家正在调度执行链；可恢复的交付错误会自动重跑一次。"
      : "管家正在推进下一步..."
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
    dispatch: "执行会话已接收",
    verify: "验证已完成",
    promote: "提升已完成",
    retry: "这一步已重新排队"
  };
  await runAction(labels[action] ?? "执行记录已更新", () => api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`), {
    button,
    pendingMessage: action === "retry" ? "正在重新跑这一步..." : "正在执行排障操作..."
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
    ...tasks.filter((task) => ["blocked", "rework", "failed"].includes(task.state))
  ];
  const butlerSessions = sessions.filter((session) => session.role === "butler-controller");
  const usableSessions = sessions.filter((session) => ["reachable", "attached"].includes(session.health?.status));
  const reachableSessions = sessions.filter((session) => session.health?.status === "reachable");
  const attachedSessions = sessions.filter((session) => session.health?.status === "attached");
  const unreachableSessions = sessions.filter((session) => session.health?.status === "unreachable");

  elements.goalCount.textContent = goals.length;
  elements.activeGoalCount.textContent = `${activeGoals.length} 个进行中`;
  elements.taskCount.textContent = tasks.length;
  elements.queuedTaskCount.textContent = `${queuedTasks.length} 步等待推进`;
  elements.blockedCount.textContent = blocked.length;
  elements.sessionCount.textContent = sessions.length;
  elements.butlerSessionCount.textContent = `${usableSessions.length} 个可复用，${unreachableSessions.length} 个不可达`;
  renderReadiness(sessions, usableSessions, attachedSessions, unreachableSessions, data.daemon);
  renderDaemon(data.daemon);
  renderGoals(goals, data.goalProgress ?? {}, tasks, sessions);
  renderSessions(sessions);
  renderTasks(tasks);
  renderEvents(events);
}

function renderDaemon(daemon) {
  const status = daemon?.status ?? "unknown";
  elements.startDaemonButton.hidden = status === "running";
  elements.stopDaemonButton.hidden = true;
  elements.daemonTile.innerHTML = `
    <span class="status-dot ${classForState(status)}" aria-hidden="true"></span>
    <span>${escapeHtml(daemonStatusLabel(status))}</span>
  `;
}

function renderReadiness(sessions, usableSessions, attachedSessions, unreachableSessions, daemon) {
  if (daemon?.status === "running") {
    elements.readinessTitle.textContent = "可以推进";
    elements.readinessText.textContent = "后台已就绪。管家可以创建新的执行会话；旧会话只影响复用。";
    return;
  }
  if (sessions.length === 0) {
    elements.readinessTitle.textContent = "后台未运行";
    elements.readinessText.textContent = "先点“启动后台”，再输入目标。";
    return;
  }
  if (usableSessions.length > 0) {
    elements.readinessTitle.textContent = "后台未运行";
    if (attachedSessions.length > 0 && unreachableSessions.length > 0) {
      elements.readinessText.textContent = "先启动后台。已有会话状态可在高级选项里查看。";
    } else if (attachedSessions.length > 0) {
      elements.readinessText.textContent = "当前 Codex 会话已附着，但后台仍需启动。";
    } else {
      elements.readinessText.textContent = "已有会话可复用，但后台仍需启动。";
    }
    return;
  }
  elements.readinessTitle.textContent = "后台未运行";
  elements.readinessText.textContent = unreachableSessions.length > 0
    ? "先启动后台。已登记的旧会话目前不可复用，但不影响创建新目标。"
    : "先启动后台；已有会话可稍后再检查。";
}

function renderGoals(goals, goalProgress, tasks, sessions) {
  if (goals.length === 0) {
    elements.goalsList.innerHTML = `<div class="empty-state">当前没有管家接管的目标。下面输入一句你要完成的事，Butler 会创建执行链并推进到边界。</div>`;
    return;
  }
  elements.goalsList.innerHTML = goals.map((goal) => {
    const progress = goalProgress[goal.id] ?? null;
    const goalTasks = tasks.filter((task) => task.goalId === goal.id);
    const sessionSummary = summarizeSessions(sessions);
    return `
    <article class="goal-item ${goalTone(progress)}">
      <p class="eyebrow">${goal.state === "done" ? "已完成目标" : "管家正在接管"}</p>
      <p class="item-title">${escapeHtml(goal.objective)}</p>
      ${renderGoalDiagnosis(progress)}
      ${renderButlerCommand(progress, sessionSummary)}
      ${renderNextAction(progress)}
      ${renderGoalPipeline(goalTasks)}
      <div class="row-actions">
        <button class="mini-button primary-mini" data-goal-action="advance" data-goal-id="${escapeHtml(goal.id)}" data-max-steps="20">${escapeHtml(primaryGoalAction(progress))}</button>
        <button class="mini-button" data-goal-action="advance" data-goal-id="${escapeHtml(goal.id)}" data-max-steps="1">只推进一步</button>
      </div>
      <details class="technical-details">
        <summary>技术细节</summary>
        <div class="item-meta">
          <span class="pill ${classForState(goal.state)}">${escapeHtml(goal.state)}</span>
          <span class="pill">${escapeHtml(shortId(goal.id))}</span>
          <span class="pill">${goal.history?.length ?? 0} 条记录</span>
        </div>
      </details>
    </article>
  `;
  }).join("");
}

function renderButlerCommand(progress, sessions) {
  const phase = butlerPhase(progress);
  return `
    <div class="butler-command">
      <div>
        <span class="diagnosis-label">管家判断</span>
        <strong>${escapeHtml(phase.title)}</strong>
        <p>${escapeHtml(phase.detail)}</p>
      </div>
      <div class="command-stats" aria-label="会话状态">
        <span><strong>${sessions.controllers}</strong><small>管家会话</small></span>
        <span><strong>${sessions.reusable}</strong><small>可复用执行会话</small></span>
        <span><strong>${sessions.unreachable}</strong><small>不可达旧会话</small></span>
      </div>
    </div>
  `;
}

function renderNextAction(progress) {
  return `<p class="next-action">${escapeHtml(nextActionText(progress))}</p>`;
}

function renderGoalPipeline(tasks) {
  if (tasks.length === 0) return "";
  return `
    <div class="goal-pipeline" aria-label="管家执行链">
      <span class="pipeline-step controller">
        <strong>管家</strong>
        <small>调度</small>
      </span>
      ${tasks.map((task) => `
        <span class="pipeline-step ${classForState(task.state)}">
          <strong>${escapeHtml(taskRoleLabel(task.ownerRole))}</strong>
          <small>${escapeHtml(taskStateLabel(task.state))}</small>
        </span>
      `).join("")}
    </div>
  `;
}

function renderSessions(sessions) {
  if (sessions.length === 0) {
    elements.sessionsList.innerHTML = `<div class="empty-state">还没有登记已有会话。普通使用不需要先添加。</div>`;
    return;
  }
  elements.sessionsList.innerHTML = sessions.map((session) => `
    <article class="goal-item">
      <div class="item-meta">
        <span class="pill ${session.role === "butler-controller" ? "good" : ""}">${escapeHtml(sessionRoleLabel(session.role))}</span>
        <span class="pill ${classForState(session.health?.status)}">${escapeHtml(sessionHealthLabel(session.health?.status))}</span>
      </div>
      <p class="item-title">${escapeHtml(session.label)}</p>
      <p class="item-subtitle">${escapeHtml(sessionSummary(session))}</p>
      <details class="technical-details">
        <summary>技术细节</summary>
        <p class="item-subtitle">${escapeHtml(session.threadId)}${session.cwd ? ` · ${escapeHtml(session.cwd)}` : ""} · ${escapeHtml(session.source)} · ${escapeHtml(shortId(session.id))}</p>
      </details>
      <div class="row-actions">
        <button class="mini-button" data-session-action="probe" data-session-id="${escapeHtml(session.id)}">检查可用性</button>
      </div>
    </article>
  `).join("");
}

function renderTasks(tasks) {
  if (tasks.length === 0) {
    elements.taskTable.innerHTML = `<div class="empty-state">还没有底层执行记录。目标开始后，这里只用于排障。</div>`;
    return;
  }
  elements.taskTable.innerHTML = tasks.map((task) => `
    <article class="task-row">
      <div>
        <div class="item-meta">
          <span class="pill ${classForState(task.state)}">${escapeHtml(taskStateLabel(task.state))}</span>
          <span class="pill">${escapeHtml(taskRoleLabel(task.ownerRole))}</span>
        </div>
        <p class="item-title">${escapeHtml(task.objective)}</p>
        <p class="item-subtitle">${task.targetTaskId ? "依赖上一步结果" : "独立步骤"}${taskUsesWorktree(task) && task.worktreePath ? " · 已准备隔离工作区" : ""}</p>
        ${renderTaskIssue(task)}
        <details class="technical-details">
          <summary>技术细节</summary>
          <p class="item-subtitle">${escapeHtml(task.ownerRole)} · ${escapeHtml(task.state)} · ${escapeHtml(shortId(task.id))}${task.targetTaskId ? ` · target ${escapeHtml(shortId(task.targetTaskId))}` : ""}</p>
        </details>
      </div>
      ${renderTaskActions(task)}
    </article>
  `).join("");
}

function renderGoalDiagnosis(progress) {
  if (!progress) return "";
  const tone = goalTone(progress);
  const details = (progress.details ?? []).slice(0, 3);
  const title = goalStatusTitle(progress);
  const text = goalStatusText(progress);
  return `
    <div class="diagnosis ${tone}">
      <span class="diagnosis-label">现在状态</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(text)}</p>
      ${details.length > 0 ? `<details><summary>错误原文</summary><ul>${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul></details>` : ""}
    </div>
  `;
}

function renderTaskIssue(task) {
  if (!["rework", "blocked", "failed"].includes(task.state)) return "";
  const details = taskIssueDetails(task).slice(0, 4);
  if (details.length === 0) {
    return `<div class="diagnosis bad"><strong>执行会话已停止，需要人工处理或重跑。</strong></div>`;
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
    buttons.push(taskButton(task, "retry", "重新跑这一步", true));
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
    return `<div class="row-actions"><span class="inline-note">由管家接管状态推进</span></div>`;
  }
  return `<div class="row-actions">${buttons.join("")}</div>`;
}

function taskButton(task, action, label, primary = false) {
  return `<button class="mini-button ${primary ? "primary-mini" : ""}" data-action="${escapeHtml(action)}" data-task-id="${escapeHtml(task.id)}">${escapeHtml(label)}</button>`;
}

function taskUsesWorktree(task) {
  return ["iteration-worker", "refine-worker"].includes(task.ownerRole);
}

function goalTone(progress) {
  if (!progress) return "warn";
  if (progress.status === "complete") return "good";
  if (progress.status === "stalled" && !canAutoRecover(progress)) return "bad";
  return "warn";
}

function goalStatusTitle(progress) {
  if (!progress) return "等待开始";
  if (progress.status === "complete") return "已完成";
  if (progress.status === "runnable") return "可以继续推进";
  if (progress.status === "active") return "正在处理";
  if (progress.status === "waiting") return "等待前置步骤";
  if (progress.status === "stalled" && canAutoRecover(progress)) return "可自动修复";
  if (progress.status === "stalled") return "需要处理";
  return "等待管家调度";
}

function goalStatusText(progress) {
  if (!progress) return "输入目标后，Butler 会开始生成执行链。";
  if (progress.status === "complete") return "目标链路已经跑完。需要查看细节时再展开排障区。";
  if (progress.status === "runnable") return "下一步已经准备好。推荐让管家继续推进到完成或明确边界。";
  if (progress.status === "active") return "管家正在等待执行会话返回，稍后会自动刷新状态。";
  if (progress.status === "waiting") return "前置步骤还没有完成。等上一轮结果回来后继续推进。";
  if (progress.status === "stalled" && canAutoRecover(progress)) {
    return "执行会话返回的格式不合格，不是你要手动排查的问题。让管家修复并继续即可。";
  }
  if (progress.status === "stalled") {
    return "Butler 已处理到当前边界，但这一步仍没有给出合格交付。先展开错误原文确认原因，再决定重新规划或人工处理。";
  }
  return progress.message;
}

function nextActionText(progress) {
  if (!progress) return "下一步：输入目标后，管家自动建立执行链。";
  if (progress.status === "complete") return "下一步：查看结果或开始一个新目标。";
  if (progress.status === "stalled" && canAutoRecover(progress)) {
    return "下一步：让管家修复这次交付格式问题，并继续调度后续执行会话。";
  }
  if (progress.status === "stalled") return "下一步：展开错误原文，确认是否需要调整目标或人工处理。";
  if (progress.status === "waiting") return "下一步：等待前置结果完成后继续。";
  if (progress.status === "active") return "下一步：等待执行会话返回，页面会自动刷新。";
  return "下一步：让管家继续推进到完成或明确边界。";
}

function primaryGoalAction(progress) {
  if (progress?.status === "stalled" && canAutoRecover(progress)) return "让管家修复并继续";
  if (progress?.status === "complete") return "查看结果";
  return "让管家继续推进";
}

function butlerPhase(progress) {
  if (!progress) {
    return {
      title: "待命",
      detail: "还没有目标交给管家。"
    };
  }
  if (progress.status === "complete") {
    return {
      title: "交付完成",
      detail: "管家已经跑完整条执行链。"
    };
  }
  if (progress.status === "stalled" && canAutoRecover(progress)) {
    return {
      title: "可自修复",
      detail: "问题在执行会话的交付格式，管家可以重新调度一次。"
    };
  }
  if (progress.status === "stalled") {
    return {
      title: "需要你判断",
      detail: "管家已经推进到边界，需要你确认是否改目标、重跑或人工处理。"
    };
  }
  if (progress.status === "active") {
    return {
      title: "等待执行会话",
      detail: "管家已派发当前步骤，正在等结果返回。"
    };
  }
  return {
    title: "可继续推进",
    detail: "管家可以继续调度下一批执行会话。"
  };
}

function summarizeSessions(sessions) {
  return {
    controllers: sessions.filter((session) => session.role === "butler-controller").length,
    reusable: sessions.filter((session) => session.role !== "butler-controller" && session.health?.status === "reachable").length,
    unreachable: sessions.filter((session) => session.health?.status === "unreachable").length
  };
}

function canAutoRecover(progress) {
  return Boolean(progress?.recoverable) && Number(progress?.recoveries ?? 0) < 1;
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
  if (target.actions?.some((action) => action.action === "auto-retry")) {
    return "Butler 已自动重跑一次，但同一步仍未给出合格交付。请展开错误原文查看原因。";
  }
  return target.progress?.message
    ?? target.actions?.at?.(-1)?.progress?.message
    ?? target.actions?.at?.(-1)?.reason
    ?? "已停止：没有可执行的下一步。";
}

function daemonStatusLabel(status) {
  if (status === "running") return "后台运行中";
  if (status === "stopped") return "后台已停止";
  if (status === "stale") return "后台状态待刷新";
  return "后台状态未知";
}

function sessionRoleLabel(role) {
  if (role === "butler-controller") return "管家";
  if (role === "worker-session") return "执行会话";
  return role;
}

function sessionHealthLabel(status) {
  if (status === "reachable") return "可复用";
  if (status === "attached") return "当前会话";
  if (status === "unreachable") return "不可达";
  return "未检查";
}

function sessionSummary(session) {
  const health = sessionHealthLabel(session.health?.status);
  if (session.health?.status === "unreachable") return "这个旧会话现在不可复用，不影响新目标推进。";
  if (session.health?.status === "attached") return "当前正在对话的 Codex 会话已接入 Butler。";
  if (session.health?.status === "reachable") return "这个已有会话当前可复用。";
  return `${health}；需要时可以检查可用性。`;
}

function taskStateLabel(state) {
  const labels = {
    queued: "等待推进",
    leased: "已领取",
    dispatched: "已派发",
    awaiting_result: "等待结果",
    validating: "等待验证",
    review: "审查中",
    verified: "已验证",
    promoted: "已交付",
    rework: "需重跑",
    blocked: "已阻塞",
    failed: "失败"
  };
  return labels[state] ?? state;
}

function taskRoleLabel(role) {
  const labels = {
    "analysis-worker": "分析",
    "iteration-worker": "实现",
    "review-worker": "审查",
    "refine-worker": "优化",
    verifier: "验证",
    promoter: "收尾"
  };
  return labels[role] ?? role;
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
