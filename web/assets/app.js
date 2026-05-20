const state = {
  dashboard: null,
  busy: false
};

const elements = {
  plannerForm: document.querySelector("#plannerForm"),
  objectiveInput: document.querySelector("#objectiveInput"),
  formHelp: document.querySelector("#formHelp"),
  refreshButton: document.querySelector("#refreshButton"),
  startDaemonButton: document.querySelector("#startDaemonButton"),
  stopDaemonButton: document.querySelector("#stopDaemonButton"),
  daemonTile: document.querySelector("#daemonTile"),
  goalCount: document.querySelector("#goalCount"),
  activeGoalCount: document.querySelector("#activeGoalCount"),
  taskCount: document.querySelector("#taskCount"),
  queuedTaskCount: document.querySelector("#queuedTaskCount"),
  blockedCount: document.querySelector("#blockedCount"),
  verifiedCount: document.querySelector("#verifiedCount"),
  goalsList: document.querySelector("#goalsList"),
  taskTable: document.querySelector("#taskTable"),
  eventLog: document.querySelector("#eventLog"),
  toast: document.querySelector("#toast")
};

elements.plannerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const objective = elements.objectiveInput.value.trim();
  if (!objective) return;
  await runAction("Plan created", () => api("/api/goals/plan", {
    method: "POST",
    body: JSON.stringify({ objective })
  }));
  elements.objectiveInput.value = "";
  await refresh();
});

elements.refreshButton.addEventListener("click", () => refresh());
elements.startDaemonButton.addEventListener("click", () => runAction("Daemon started", () => api("/api/daemon/start")).then(refresh));
elements.stopDaemonButton.addEventListener("click", () => runAction("Daemon stopped", () => api("/api/daemon/stop")).then(refresh));

elements.taskTable.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const taskId = button.dataset.taskId;
  const action = button.dataset.action;
  const labels = {
    "allocate-worktree": "Worktree allocated",
    dispatch: "Task dispatched",
    verify: "Task verified",
    promote: "Task promoted"
  };
  await runAction(labels[action] ?? "Task updated", () => api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`));
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

async function runAction(successMessage, fn) {
  try {
    await fn();
    showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
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
  const events = data.recentEvents ?? [];
  const activeGoals = goals.filter((goal) => !["done", "failed"].includes(goal.state));
  const queuedTasks = tasks.filter((task) => task.state === "queued");
  const blocked = [
    ...goals.filter((goal) => goal.state === "blocked"),
    ...tasks.filter((task) => task.state === "blocked")
  ];
  const verified = tasks.filter((task) => ["verified", "promoted"].includes(task.state));

  elements.goalCount.textContent = goals.length;
  elements.activeGoalCount.textContent = `${activeGoals.length} active`;
  elements.taskCount.textContent = tasks.length;
  elements.queuedTaskCount.textContent = `${queuedTasks.length} queued`;
  elements.blockedCount.textContent = blocked.length;
  elements.verifiedCount.textContent = verified.length;
  renderDaemon(data.daemon);
  renderGoals(goals);
  renderTasks(tasks);
  renderEvents(events);
}

function renderDaemon(daemon) {
  const status = daemon?.status ?? "unknown";
  elements.daemonTile.innerHTML = `
    <span class="status-dot ${classForState(status)}" aria-hidden="true"></span>
    <span>Daemon ${escapeHtml(status)}${daemon?.pid ? ` · pid ${daemon.pid}` : ""}</span>
  `;
}

function renderGoals(goals) {
  if (goals.length === 0) {
    elements.goalsList.innerHTML = `<div class="empty-state">No goals yet. Plan an objective to create the execution graph.</div>`;
    return;
  }
  elements.goalsList.innerHTML = goals.map((goal) => `
    <article class="goal-item">
      <div class="item-meta">
        <span class="pill ${classForState(goal.state)}">${escapeHtml(goal.state)}</span>
        <span class="pill">${escapeHtml(shortId(goal.id))}</span>
      </div>
      <p class="item-title">${escapeHtml(goal.objective)}</p>
      <p class="item-subtitle">${goal.history?.length ?? 0} transitions recorded</p>
    </article>
  `).join("");
}

function renderTasks(tasks) {
  if (tasks.length === 0) {
    elements.taskTable.innerHTML = `<div class="empty-state">No tasks yet. Planned goals will appear here with review, verifier, and promoter gates.</div>`;
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
        <p class="item-subtitle">${task.targetTaskId ? `targets ${shortId(task.targetTaskId)}` : "direct task"}${task.worktreePath ? " · worktree ready" : ""}</p>
      </div>
      <div class="row-actions">
        <button class="mini-button" data-action="allocate-worktree" data-task-id="${escapeHtml(task.id)}">Worktree</button>
        <button class="mini-button" data-action="dispatch" data-task-id="${escapeHtml(task.id)}">Dispatch</button>
        <button class="mini-button" data-action="verify" data-task-id="${escapeHtml(task.id)}">Verify</button>
        <button class="mini-button" data-action="promote" data-task-id="${escapeHtml(task.id)}">Promote</button>
      </div>
    </article>
  `).join("");
}

function renderEvents(events) {
  if (events.length === 0) {
    elements.eventLog.innerHTML = `<div class="empty-state">No ledger events recorded.</div>`;
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
  if (["running", "planned", "validating", "verified", "promoted"].includes(state)) return "good";
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

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.style.borderColor = isError ? "rgba(162, 51, 45, 0.64)" : "rgba(244, 240, 232, 0.18)";
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("visible"), 2800);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
