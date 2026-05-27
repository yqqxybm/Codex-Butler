import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDetailReader } from "../src/sessionDetails.js";

test("session detail reader enriches sessions from index and recent transcript", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
  const threadId = "019e39f7-3daa-7592-8860-010e3ab41466";
  await writeFile(join(codexHome, "session_index.jsonl"), [
    JSON.stringify({ id: threadId, thread_name: "旧标题", updated_at: "2026-05-18T07:00:00.000Z" }),
    JSON.stringify({ id: threadId, thread_name: "开发 Codex 会话查看APP", updated_at: "2026-05-18T07:24:36.369Z" })
  ].join("\n"), "utf8");

  const sessionDir = join(codexHome, "sessions", "2026", "05", "18");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, `rollout-2026-05-18T15-22-45-${threadId}.jsonl`), [
    JSON.stringify({
      timestamp: "2026-05-18T07:22:45.000Z",
      type: "session_meta",
      payload: { cwd: "/repo/app", originator: "Codex Desktop", model: "gpt-test" }
    }),
    JSON.stringify({
      timestamp: "2026-05-18T07:23:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "继续推进 session 查看器，先修列表信息不足的问题。" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-18T07:24:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "已开始梳理 session 列表的数据来源。" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-05-18T07:24:10.000Z",
      type: "event_msg",
      payload: { type: "token_count", message: "not a user message" }
    })
  ].join("\n"), "utf8");

  const reader = new SessionDetailReader({ codexHome });
  const enriched = await reader.enrichSessions([{
    id: "session-1",
    threadId,
    label: "Imported worker 5",
    cwd: "/fallback"
  }]);

  assert.equal(enriched[0].details.threadName, "开发 Codex 会话查看APP");
  assert.equal(enriched[0].details.cwd, "/repo/app");
  assert.equal(enriched[0].details.originator, "Codex Desktop");
  assert.match(enriched[0].details.lastUserMessage, /session 查看器/);
  assert.match(enriched[0].details.lastAssistantMessage, /数据来源/);
  assert.equal(enriched[0].details.transcriptFound, true);
});

test("session detail reader refreshes transcript paths for newly available sessions", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
  const threadId = "019e39f7-3daa-7592-8860-010e3ab41466";
  await writeFile(join(codexHome, "session_index.jsonl"), "", "utf8");

  const reader = new SessionDetailReader({ codexHome });
  const session = {
    id: "session-1",
    threadId,
    label: "Imported worker 5",
    cwd: "/fallback"
  };

  const first = await reader.enrichSessions([session]);
  assert.equal(first[0].details.transcriptFound, false);

  const sessionDir = join(codexHome, "sessions", "2026", "05", "18");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, `rollout-2026-05-18T15-22-45-${threadId}.jsonl`), JSON.stringify({
    timestamp: "2026-05-18T07:23:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "新导入 session 后应该立刻能识别。" }]
    }
  }), "utf8");

  const second = await reader.enrichSessions([session]);
  assert.equal(second[0].details.transcriptFound, true);
  assert.match(second[0].details.lastUserMessage, /新导入 session/);
});
