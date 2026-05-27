import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HEARTBEAT_MS = 1000;

export function daemonPaths(dataDir) {
  return {
    statePath: join(dataDir, "daemon.json")
  };
}

export async function readDaemonStatus(options = {}) {
  const dataDir = options.dataDir ?? join(options.projectRoot ?? process.cwd(), ".codex-butler");
  const isPidRunning = options.isPidRunning ?? defaultIsPidRunning;
  const record = await readDaemonRecord(dataDir);
  if (!record) return { status: "stopped", dataDir };
  if (record.status === "running" && !isPidRunning(record.pid)) {
    return { ...record, status: "stale", dataDir };
  }
  return { ...record, dataDir };
}

export async function startDaemon(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dataDir = options.dataDir ?? join(projectRoot, ".codex-butler");
  const status = await readDaemonStatus({
    dataDir,
    isPidRunning: options.isPidRunning
  });
  if (status.status === "running") {
    return { ok: true, ...status, reused: true };
  }

  await mkdir(dataDir, { recursive: true });
  const child = (options.spawnImpl ?? spawn)(
    options.nodePath ?? process.execPath,
    [
      options.scriptPath ?? fileURLToPath(new URL("./daemonWorker.js", import.meta.url)),
      "--project-root",
      projectRoot,
      "--data-dir",
      dataDir
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore"
    }
  );
  if (typeof child.unref === "function") child.unref();
  const record = {
    status: "running",
    pid: child.pid,
    projectRoot,
    dataDir,
    startedAt: new Date().toISOString(),
    heartbeatAt: null
  };
  await writeDaemonRecord(dataDir, record);
  return { ok: true, ...record, reused: false };
}

export async function stopDaemon(options = {}) {
  const dataDir = options.dataDir ?? join(options.projectRoot ?? process.cwd(), ".codex-butler");
  const isPidRunning = options.isPidRunning ?? defaultIsPidRunning;
  const killImpl = options.killImpl ?? process.kill;
  const status = await readDaemonStatus({ dataDir, isPidRunning });
  if (!["running", "stale"].includes(status.status)) {
    return { ok: true, status: "stopped", dataDir, reused: true };
  }
  if (status.status === "running") {
    try {
      killImpl(status.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const record = {
    ...status,
    status: "stopped",
    stoppedAt: new Date().toISOString()
  };
  await writeDaemonRecord(dataDir, record);
  return { ok: true, ...record };
}

export async function runDaemon(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dataDir = options.dataDir ?? join(projectRoot, ".codex-butler");
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const onHeartbeat = options.onHeartbeat ?? null;
  const startedAt = new Date().toISOString();
  let heartbeatBusy = false;
  await mkdir(dataDir, { recursive: true });
  await writeDaemonRecord(dataDir, {
    status: "running",
    pid: process.pid,
    projectRoot,
    dataDir,
    startedAt,
    heartbeatAt: new Date().toISOString()
  });

  return new Promise((resolve) => {
    const heartbeat = setInterval(async () => {
      if (onHeartbeat && !heartbeatBusy) {
        heartbeatBusy = true;
        try {
          await onHeartbeat();
        } catch {
          // Keep the daemon alive; operational errors are reflected in Butler state.
        } finally {
          heartbeatBusy = false;
        }
      }
      await writeDaemonRecord(dataDir, {
        status: "running",
        pid: process.pid,
        projectRoot,
        dataDir,
        startedAt,
        heartbeatAt: new Date().toISOString()
      });
    }, heartbeatMs);

    const shutdown = async () => {
      clearInterval(heartbeat);
      const record = {
        status: "stopped",
        pid: process.pid,
        projectRoot,
        dataDir,
        stoppedAt: new Date().toISOString()
      };
      await writeDaemonRecord(dataDir, record);
      resolve(record);
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}

async function readDaemonRecord(dataDir) {
  try {
    return JSON.parse(await readFile(daemonPaths(dataDir).statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeDaemonRecord(dataDir, record) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(daemonPaths(dataDir).statePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function defaultIsPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
