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

    const result = await client.callTool({
      name: "butler_submit_goal",
      arguments: { objective: "test mcp submit goal" }
    });
    const text = result.content.find((item) => item.type === "text").text;
    const goal = JSON.parse(text);
    assert.equal(goal.objective, "test mcp submit goal");
    assert.equal(goal.state, "intake");
  } finally {
    await client.close();
  }
});
