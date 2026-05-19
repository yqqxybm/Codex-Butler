import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexAppServerClient } from "./codexAppServerClient.js";

export async function runCapabilityProbe(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const checks = [];

  const codexVersion = await runCommand("codex", ["--version"], { cwd });
  checks.push(commandCheck("codex_version", codexVersion));

  const daemonVersion = await runCommand("codex", ["app-server", "daemon", "version"], { cwd });
  checks.push(commandCheck("app_server_daemon_version", daemonVersion));

  const schema = await generateAndAnalyzeSchema(cwd);
  checks.push({
    name: "app_server_schema",
    ok: schema.ok,
    detail: schema
  });

  const config = await readCodexConfig();
  checks.push({
    name: "global_config_risk",
    ok: true,
    detail: analyzeConfigRisk(config)
  });

  const transport = await runTransportProbe(cwd);
  checks.push({
    name: "app_server_stdio_transport",
    ok: transport.ok,
    detail: transport
  });

  const ok = checks.every((check) => check.ok);
  return { ok, checks };
}

export async function generateAndAnalyzeSchema(cwd) {
  const outDir = await mkdtemp(join(tmpdir(), "codex-butler-schema-"));
  const generated = await runCommand("codex", [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    outDir
  ], { cwd });
  if (generated.exitCode !== 0) {
    return {
      ok: false,
      outDir,
      error: generated.stderr || generated.stdout
    };
  }
  return analyzeSchemaBundle(outDir);
}

export async function analyzeSchemaBundle(outDir) {
  const v2Dir = join(outDir, "v2");
  const requiredFiles = [
    "ThreadStartParams.json",
    "TurnStartParams.json",
    "ThreadReadParams.json",
    "TurnCompletedNotification.json",
    "CommandExecParams.json"
  ];
  const files = existsSync(v2Dir) ? await readdir(v2Dir) : [];
  const missingFiles = requiredFiles.filter((file) => !files.includes(file));
  const turnStartPath = join(v2Dir, "TurnStartParams.json");
  const commandExecPath = join(v2Dir, "CommandExecParams.json");
  const turnStart = existsSync(turnStartPath)
    ? JSON.parse(await readFile(turnStartPath, "utf8"))
    : {};
  const commandExec = existsSync(commandExecPath)
    ? JSON.parse(await readFile(commandExecPath, "utf8"))
    : {};
  const turnProps = Object.keys(turnStart.properties ?? {});
  const commandProps = Object.keys(commandExec.properties ?? {});
  const requiredTurnFields = ["threadId", "input", "outputSchema", "permissions", "sandboxPolicy"];
  const requiredCommandFields = ["command", "cwd", "sandboxPolicy", "permissionProfile"];
  const missingTurnFields = requiredTurnFields.filter((field) => !turnProps.includes(field));
  const missingCommandFields = requiredCommandFields.filter((field) => !commandProps.includes(field));
  return {
    ok: missingFiles.length === 0 && missingTurnFields.length === 0 && missingCommandFields.length === 0,
    outDir,
    missingFiles,
    missingTurnFields,
    missingCommandFields
  };
}

export async function readCodexConfig(path = join(homedir(), ".codex", "config.toml")) {
  if (!existsSync(path)) return { path, exists: false, values: {} };
  const text = await readFile(path, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"?([^"#]+)"?\s*(?:#.*)?$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return { path, exists: true, values };
}

export function analyzeConfigRisk(config) {
  const approvalPolicy = config.values.approval_policy ?? null;
  const sandboxMode = config.values.sandbox_mode ?? null;
  const risks = [];
  if (approvalPolicy === "never") {
    risks.push("global approval_policy=never; Butler must not rely on prompt-only approval gates");
  }
  if (sandboxMode === "danger-full-access") {
    risks.push("global sandbox_mode=danger-full-access; worker isolation must be enforced per thread/turn");
  }
  return {
    path: config.path,
    exists: config.exists,
    approvalPolicy,
    sandboxMode,
    risks
  };
}

async function runTransportProbe(cwd) {
  const client = new CodexAppServerClient({ cwd });
  try {
    const init = await client.initialize();
    const thread = await client.startEphemeralThread(cwd);
    const pwd = await client.commandExec({
      command: ["/bin/sh", "-lc", "pwd"],
      cwd,
      timeoutMs: 5000,
      sandboxPolicy: { type: "readOnly", networkAccess: false }
    });
    const denied = await client.runReadOnlyWriteProbe(
      cwd,
      join(tmpdir(), `codex-butler-readonly-${randomUUID()}`)
    );
    return {
      ok: Boolean(init?.userAgent)
        && Boolean(thread?.thread?.id)
        && pwd.exitCode === 0
        && denied.denied,
      userAgent: init?.userAgent ?? null,
      platformOs: init?.platformOs ?? null,
      threadId: thread?.thread?.id ?? null,
      threadEphemeral: thread?.thread?.ephemeral ?? null,
      threadSandbox: thread?.sandbox ?? null,
      pwd: pwd.stdout.trim(),
      readOnlyWriteDenied: denied
    };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    client.close();
  }
}

function commandCheck(name, result) {
  return {
    name,
    ok: result.exitCode === 0,
    detail: {
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    }
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}
