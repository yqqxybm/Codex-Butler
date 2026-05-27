import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebServer } from "../src/webServer.js";
import { ButlerService } from "../src/butlerService.js";

test("web server serves the app shell and status API", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const page = await fetchText(`${baseUrl}/`);
    assert.match(page, /Codex Butler/);
    assert.match(page, /一键管家/);
    assert.match(page, /启动管家托管/);
    assert.match(page, /app\.js/);

    const app = await fetchText(`${baseUrl}/assets/app.js`);
    assert.match(app, /目标已经完成，没有新的推进动作/);
    assert.match(app, /第一轮 resume 失败会直接阻塞/);
    assert.match(app, /工作 session/);
    assert.match(app, /sessionRunsList/);
    assert.match(app, /不能视为已接管/);

    const status = await fetchJson(`${baseUrl}/api/status`);
    assert.equal(status.goals.length, 0);
    assert.equal(status.tasks.length, 0);
  } finally {
    await close();
  }
});

test("web server exposes one-click product actions", async () => {
  const service = {
    async planGoal({ objective }) {
      return { goal: { id: "goal-web-run", objective }, tasks: [] };
    },
    async advanceGoal({ goalId, maxSteps }) {
      return { ok: true, goal: { id: goalId }, actions: [{ action: "done", ok: true, maxSteps }] };
    },
    async probeAllSessions() {
      return { ok: true, total: 2, reachable: 2, results: [] };
    },
    async retryTask({ taskId }) {
      return { id: taskId, state: "queued" };
    },
    async resumeBlockedTask({ taskId, note }) {
      return { id: taskId, state: "queued", contextNotes: [{ note }] };
    },
    async startSessionRun({ sessionIdOrThreadId, objective, maxTurns }) {
      return { ok: true, run: { id: "session-run-web", state: "active", sessionIdOrThreadId, objective, maxTurns } };
    },
    async advanceSessionRun({ runId, maxTurns }) {
      return { ok: true, run: { id: runId, state: "active", maxTurns } };
    },
    async resumeSessionRun({ runId, note, maxTurns }) {
      return { ok: true, run: { id: runId, state: "done", note, maxTurns } };
    }
  };
  const server = createWebServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const planned = await fetchJson(`${baseUrl}/api/goals/plan-and-run`, {
      method: "POST",
      body: JSON.stringify({ objective: "Ship the user flow", maxSteps: 3 })
    });
    assert.equal(planned.planned.goal.id, "goal-web-run");
    assert.equal(planned.advanced.actions[0].maxSteps, 3);

    const advanced = await fetchJson(`${baseUrl}/api/goals/goal-web-run/advance`, {
      method: "POST",
      body: JSON.stringify({ maxSteps: 1 })
    });
    assert.equal(advanced.ok, true);

    const probes = await fetchJson(`${baseUrl}/api/sessions/probe-all`, { method: "POST" });
    assert.equal(probes.reachable, 2);

    const retried = await fetchJson(`${baseUrl}/api/tasks/task-web/retry`, { method: "POST" });
    assert.equal(retried.state, "queued");

    const resumed = await fetchJson(`${baseUrl}/api/tasks/task-web/resume`, {
      method: "POST",
      body: JSON.stringify({ note: "Use product usability first." })
    });
    assert.equal(resumed.contextNotes[0].note, "Use product usability first.");

    const followed = await fetchJson(`${baseUrl}/api/sessions/session-web/autopilot`, {
      method: "POST",
      body: JSON.stringify({ objective: "Finish this session", maxTurns: 2 })
    });
    assert.equal(followed.run.id, "session-run-web");
    assert.equal(followed.run.maxTurns, 2);

    const runAdvanced = await fetchJson(`${baseUrl}/api/session-runs/session-run-web/advance`, {
      method: "POST",
      body: JSON.stringify({ maxTurns: 2 })
    });
    assert.equal(runAdvanced.run.id, "session-run-web");

    const runResumed = await fetchJson(`${baseUrl}/api/session-runs/session-run-web/resume`, {
      method: "POST",
      body: JSON.stringify({ note: "Choose simple mode.", maxTurns: 2 })
    });
    assert.equal(runResumed.run.state, "done");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("web server plans goals and exposes dashboard data", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const planned = await fetchJson(`${baseUrl}/api/goals/plan`, {
      method: "POST",
      body: JSON.stringify({ objective: "Build a local web console" })
    });
    assert.equal(planned.tasks.length, 4);

    const dashboard = await fetchJson(`${baseUrl}/api/dashboard`);
    assert.match(dashboard.dashboard, /Codex Butler Dashboard/);
    assert.equal(dashboard.status.goals.length, 1);
  } finally {
    await close();
  }
});

test("web server registers an existing session as the Butler controller", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const session = await fetchJson(`${baseUrl}/api/sessions/butler`, {
      method: "POST",
      body: JSON.stringify({ threadId: "thread-web-butler", label: "Web Butler" })
    });
    assert.equal(session.role, "butler-controller");
    assert.equal(session.source, "existing-local");

    const sessions = await fetchJson(`${baseUrl}/api/sessions`, { method: "GET" });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].threadId, "thread-web-butler");

    const dashboard = await fetchJson(`${baseUrl}/api/dashboard`);
    assert.equal(dashboard.status.sessions.length, 1);
  } finally {
    await close();
  }
});

test("web server exposes a session probe route", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-butler-web-"));
  const service = new ButlerService({
    projectRoot,
    clientFactory: () => ({
      async startTurn() {
        return {
          start: { turn: { id: "turn-start" } },
          completed: { params: { turn: { id: "turn-web-probe", status: "completed" } } },
          finalText: JSON.stringify({ status: "ok", role: "session-probe" })
        };
      },
      close() {}
    })
  });
  const server = createWebServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const session = await service.addButlerSession({ threadId: "thread-web-probe" });
    const result = await fetchJson(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/probe`, {
      method: "POST"
    });
    assert.equal(result.ok, true);
    assert.equal(result.turnId, "turn-web-probe");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("web server rejects unknown API routes", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/api/missing`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Not found");
  } finally {
    await close();
  }
});

async function startTestServer() {
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-butler-web-"));
  const service = new ButlerService({ projectRoot });
  const server = createWebServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, withJsonHeaders(options));
  assert.equal(response.status, 200);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, withJsonHeaders(options));
  assert.equal(response.status, 200);
  return response.json();
}

function withJsonHeaders(options) {
  return {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  };
}
