import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes Butler tools and can submit a goal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-butler-mcp-"));
  const client = new Client({ name: "codex-butler-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/mcpServer.js")],
    cwd,
    stderr: "pipe"
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "butler_submit_goal"));
    assert.ok(tools.tools.some((tool) => tool.name === "butler_plan_goal"));
    assert.ok(tools.tools.some((tool) => tool.name === "butler_dashboard"));
    assert.ok(tools.tools.some((tool) => tool.name === "butler_daemon_status"));
    assert.ok(tools.tools.some((tool) => tool.name === "butler_add_butler_session"));
    assert.ok(tools.tools.some((tool) => tool.name === "butler_sessions"));

    const result = await client.callTool({
      name: "butler_submit_goal",
      arguments: { objective: "test mcp submit goal" }
    });
    const text = result.content.find((item) => item.type === "text").text;
    const goal = JSON.parse(text);
    assert.equal(goal.objective, "test mcp submit goal");
    assert.equal(goal.state, "intake");

    const planned = await client.callTool({
      name: "butler_plan_goal",
      arguments: { objective: "Build an MCP dashboard" }
    });
    const planText = planned.content.find((item) => item.type === "text").text;
    assert.equal(JSON.parse(planText).tasks.length, 4);

    const dashboard = await client.callTool({
      name: "butler_dashboard",
      arguments: {}
    });
    const dashboardText = dashboard.content.find((item) => item.type === "text").text;
    assert.match(JSON.parse(dashboardText).dashboard, /Codex Butler Dashboard/);

    const session = await client.callTool({
      name: "butler_add_butler_session",
      arguments: { threadId: "thread-mcp-butler", label: "MCP Butler" }
    });
    const sessionText = session.content.find((item) => item.type === "text").text;
    assert.equal(JSON.parse(sessionText).role, "butler-controller");

    const sessions = await client.callTool({
      name: "butler_sessions",
      arguments: { role: "butler-controller" }
    });
    const sessionsText = sessions.content.find((item) => item.type === "text").text;
    assert.deepEqual(JSON.parse(sessionsText).map((item) => item.threadId), ["thread-mcp-butler"]);

    const daemon = await client.callTool({
      name: "butler_daemon_status",
      arguments: {}
    });
    const daemonText = daemon.content.find((item) => item.type === "text").text;
    assert.equal(JSON.parse(daemonText).status, "stopped");
  } finally {
    await client.close();
  }
});
