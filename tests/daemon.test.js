import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDaemonStatus, startDaemon, stopDaemon } from "../src/daemon.js";

test("daemon status reports stopped when no state exists", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-butler-daemon-"));
  const status = await readDaemonStatus({ dataDir });
  assert.equal(status.status, "stopped");
});

test("daemon start writes a pid record and reuses a running daemon", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-butler-daemon-"));
  const started = await startDaemon({
    projectRoot: dataDir,
    dataDir,
    spawnImpl: fakeSpawn(4242)
  });
  assert.equal(started.ok, true);
  assert.equal(started.status, "running");
  assert.equal(started.pid, 4242);

  const record = JSON.parse(await readFile(join(dataDir, "daemon.json"), "utf8"));
  assert.equal(record.pid, 4242);
  assert.equal(record.projectRoot, dataDir);

  const reused = await startDaemon({
    projectRoot: dataDir,
    dataDir,
    spawnImpl: fakeSpawn(9999),
    isPidRunning: (pid) => pid === 4242
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.pid, 4242);
});

test("daemon status marks missing pids as stale", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-butler-daemon-"));
  await startDaemon({
    projectRoot: dataDir,
    dataDir,
    spawnImpl: fakeSpawn(5151)
  });

  const status = await readDaemonStatus({
    dataDir,
    isPidRunning: () => false
  });
  assert.equal(status.status, "stale");
  assert.equal(status.pid, 5151);
});

test("daemon stop signals the pid and records stopped state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-butler-daemon-"));
  const killed = [];
  await startDaemon({
    projectRoot: dataDir,
    dataDir,
    spawnImpl: fakeSpawn(6262)
  });

  const stopped = await stopDaemon({
    dataDir,
    isPidRunning: () => true,
    killImpl: (pid, signal) => killed.push([pid, signal])
  });

  assert.equal(stopped.status, "stopped");
  assert.deepEqual(killed, [[6262, "SIGTERM"]]);
});

test("daemon stop tolerates already-missing pids", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-butler-daemon-"));
  await startDaemon({
    projectRoot: dataDir,
    dataDir,
    spawnImpl: fakeSpawn(7373)
  });

  const stopped = await stopDaemon({
    dataDir,
    isPidRunning: () => true,
    killImpl: () => {
      const error = new Error("missing");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(stopped.status, "stopped");
});

function fakeSpawn(pid) {
  return () => ({
    pid,
    unref() {}
  });
}
