import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeConfigRisk, analyzeDaemonVersion, analyzeSchemaBundle } from "../src/capabilityProbe.js";

test("config risk flags broad global execution settings", () => {
  const risk = analyzeConfigRisk({
    path: "/tmp/config.toml",
    exists: true,
    values: {
      approval_policy: "never",
      sandbox_mode: "danger-full-access"
    }
  });
  assert.equal(risk.risks.length, 2);
});

test("schema bundle analysis requires transport and permission fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-butler-schema-test-"));
  const v2 = join(dir, "v2");
  await mkdir(v2);
  await writeFile(join(v2, "ThreadStartParams.json"), JSON.stringify({ properties: {} }));
  await writeFile(join(v2, "ThreadReadParams.json"), JSON.stringify({ properties: {} }));
  await writeFile(join(v2, "TurnCompletedNotification.json"), JSON.stringify({ properties: {} }));
  await writeFile(join(v2, "TurnStartParams.json"), JSON.stringify({
    properties: {
      threadId: {},
      input: {},
      outputSchema: {},
      permissions: {},
      sandboxPolicy: {}
    }
  }));
  await writeFile(join(v2, "CommandExecParams.json"), JSON.stringify({
    properties: {
      command: {},
      cwd: {},
      sandboxPolicy: {},
      permissionProfile: {}
    }
  }));
  const result = await analyzeSchemaBundle(dir);
  assert.equal(result.ok, true);
});

test("daemon version parser requires running status", () => {
  const running = analyzeDaemonVersion(JSON.stringify({
    status: "running",
    cliVersion: "0.131.0-alpha.9",
    appServerVersion: "0.131.0-alpha.9"
  }));
  assert.equal(running.ok, true);

  const stopped = analyzeDaemonVersion(JSON.stringify({ status: "stopped" }));
  assert.equal(stopped.ok, false);
});
