import test from "node:test";
import assert from "node:assert/strict";
import { JsonlRpcClient } from "../src/jsonlRpcClient.js";

test("waitForNotification resolves existing notifications", async () => {
  const client = new JsonlRpcClient("node", ["-e", ""], {});
  client.notifications.push({ method: "turn/completed", params: { threadId: "t1" } });
  const notification = await client.waitForNotification(
    (item) => item.method === "turn/completed" && item.params.threadId === "t1"
  );
  assert.equal(notification.params.threadId, "t1");
});
