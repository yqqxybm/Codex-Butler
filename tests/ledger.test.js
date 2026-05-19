import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLedger } from "../src/ledger.js";

test("ledger appends JSONL events without rewriting prior entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-ledger-"));
  const path = join(dir, "events.jsonl");
  const ledger = new EventLedger(path);
  const first = await ledger.append("goal.created", { goalId: "g1" });
  const second = await ledger.append("task.queued", { taskId: "t1" });
  const events = await ledger.readAll();
  const raw = await readFile(path, "utf8");

  assert.equal(events.length, 2);
  assert.equal(events[0].id, first.id);
  assert.equal(events[1].id, second.id);
  assert.equal(raw.trim().split("\n").length, 2);
});
