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
    assert.match(page, /app\.js/);

    const status = await fetchJson(`${baseUrl}/api/status`);
    assert.equal(status.goals.length, 0);
    assert.equal(status.tasks.length, 0);
  } finally {
    await close();
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
