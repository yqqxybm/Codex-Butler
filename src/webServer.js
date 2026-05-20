#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultService } from "./butlerService.js";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4177;
const MAX_BODY_BYTES = 1024 * 1024;

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
});

export function createWebServer(options = {}) {
  const service = options.service ?? createDefaultService();
  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, service);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

export async function startWebServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = Number(options.port ?? DEFAULT_PORT);
  const server = createWebServer(options);
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { server, host, port: server.address().port };
}

async function routeRequest(request, response, service) {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";
  if (url.pathname.startsWith("/api/")) {
    await routeApi(method, url, request, response, service);
    return;
  }
  if (method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  await serveStatic(url.pathname, response);
}

async function routeApi(method, url, request, response, service) {
  if (method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, await service.status());
    return;
  }
  if (method === "GET" && url.pathname === "/api/dashboard") {
    const dashboard = await service.dashboard();
    sendJson(response, 200, {
      ...dashboard,
      daemon: await service.daemonStatus()
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/ledger") {
    sendJson(response, 200, await service.readLedger());
    return;
  }
  if (method === "GET" && url.pathname === "/api/daemon/status") {
    sendJson(response, 200, await service.daemonStatus());
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    sendJson(response, 200, await service.listSessions());
    return;
  }
  if (method === "POST" && url.pathname === "/api/daemon/start") {
    sendJson(response, 200, await service.startDaemon());
    return;
  }
  if (method === "POST" && url.pathname === "/api/daemon/stop") {
    sendJson(response, 200, await service.stopDaemon());
    return;
  }
  if (method === "POST" && url.pathname === "/api/goals/submit") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await service.submitGoal({ objective: requiredText(body.objective, "objective") }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/goals/plan") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await service.planGoal({ objective: requiredText(body.objective, "objective") }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/goals/plan-and-run") {
    const body = await readJsonBody(request);
    const planned = await service.planGoal({ objective: requiredText(body.objective, "objective") });
    const advanced = await service.advanceGoal({
      goalId: planned.goal.id,
      maxSteps: body.maxSteps ?? 1
    });
    sendJson(response, 200, { planned, advanced });
    return;
  }
  const goalAction = /^\/api\/goals\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (method === "POST" && goalAction) {
    const goalId = decodeURIComponent(goalAction[1]);
    const action = goalAction[2];
    const body = await readJsonBody(request);
    if (action === "advance") {
      sendJson(response, 200, await service.advanceGoal({
        goalId,
        maxSteps: body.maxSteps ?? 1
      }));
      return;
    }
  }
  if (method === "POST" && url.pathname === "/api/sessions/register") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await service.registerSession({
      threadId: requiredText(body.threadId, "threadId"),
      role: body.role,
      label: body.label,
      source: body.source,
      cwd: body.cwd,
      notes: body.notes
    }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/sessions/butler") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await service.addButlerSession({
      threadId: requiredText(body.threadId, "threadId"),
      label: body.label,
      source: body.source,
      cwd: body.cwd,
      notes: body.notes
    }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/sessions/probe-all") {
    sendJson(response, 200, await service.probeAllSessions());
    return;
  }
  const sessionAction = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (method === "POST" && sessionAction) {
    const sessionIdOrThreadId = decodeURIComponent(sessionAction[1]);
    const action = sessionAction[2];
    if (action === "probe") {
      sendJson(response, 200, await service.probeSession({ sessionIdOrThreadId }));
      return;
    }
  }

  const taskAction = /^\/api\/tasks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (method === "POST" && taskAction) {
    const taskId = decodeURIComponent(taskAction[1]);
    const action = taskAction[2];
    const body = await readJsonBody(request);
    if (action === "allocate-worktree") {
      sendJson(response, 200, await service.allocateTaskWorktree({ taskId }));
      return;
    }
    if (action === "dispatch") {
      sendJson(response, 200, await service.dispatchTask({ taskId }));
      return;
    }
    if (action === "verify") {
      sendJson(response, 200, await service.runVerifier({ taskId, command: body.command ?? null }));
      return;
    }
    if (action === "promote") {
      sendJson(response, 200, await service.promoteTask({ taskId }));
      return;
    }
    if (action === "retry") {
      sendJson(response, 200, await service.retryTask({ taskId }));
      return;
    }
  }

  sendJson(response, 404, { error: "Not found" });
}

async function serveStatic(pathname, response) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const allowed = new Set([
    "/index.html",
    "/assets/app.js",
    "/assets/styles.css"
  ]);
  if (!allowed.has(normalized)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const filePath = join(WEB_ROOT, normalized);
  const content = await readFile(filePath);
  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store"
  });
  response.end(content);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--host") parsed.host = argv[++index];
    else if (item === "--port") parsed.port = argv[++index];
  }
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  startWebServer(args)
    .then(({ host, port }) => {
      console.log(`codex-butler web listening at http://${host}:${port}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
