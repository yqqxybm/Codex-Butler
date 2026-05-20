import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4177;
const TARGETS = Object.freeze(["daemon", "web"]);
const LABELS = Object.freeze({
  daemon: "com.codex-butler.daemon",
  web: "com.codex-butler.web"
});

export function resolveLaunchdServices(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const nodePath = options.nodePath ?? process.execPath;
  const host = options.host ?? DEFAULT_HOST;
  const port = String(options.port ?? DEFAULT_PORT);
  const pathEnv = options.pathEnv ?? defaultPathEnv(nodePath, homeDir);
  const launchAgentsDir = options.launchAgentsDir ?? join(homeDir, "Library", "LaunchAgents");
  const logDir = options.logDir ?? join(projectRoot, ".codex-butler", "logs");
  const targets = normalizeLaunchdTargets(options.target ?? "all");

  const services = {
    daemon: {
      name: "daemon",
      label: LABELS.daemon,
      plistPath: join(launchAgentsDir, `${LABELS.daemon}.plist`),
      programArguments: [nodePath, CLI_PATH, "daemon", "run"],
      workingDirectory: projectRoot,
      stdoutPath: join(logDir, "codex-butler-daemon.out.log"),
      stderrPath: join(logDir, "codex-butler-daemon.err.log"),
      environment: {
        HOME: homeDir,
        PATH: pathEnv
      }
    },
    web: {
      name: "web",
      label: LABELS.web,
      plistPath: join(launchAgentsDir, `${LABELS.web}.plist`),
      programArguments: [nodePath, CLI_PATH, "web", "--host", host, "--port", port],
      workingDirectory: projectRoot,
      stdoutPath: join(logDir, "codex-butler-web.out.log"),
      stderrPath: join(logDir, "codex-butler-web.err.log"),
      environment: {
        HOME: homeDir,
        PATH: pathEnv
      }
    }
  };

  return targets.map((target) => services[target]);
}

export async function installLaunchdServices(options = {}) {
  const uid = options.uid ?? currentUid();
  const domain = launchdDomain(uid);
  const services = resolveLaunchdServices(options);
  await prepareLaunchdFilesystem(services);

  for (const service of services) {
    await writeFile(service.plistPath, createLaunchdPlist(service), "utf8");
    if (options.load !== false) {
      await runLaunchctl(["bootout", domain, service.plistPath], {
        ...options,
        allowFailure: true
      });
      await runLaunchctl(["bootstrap", domain, service.plistPath], options);
      await runLaunchctl(["kickstart", "-k", `${domain}/${service.label}`], options);
    }
  }

  return {
    ok: true,
    domain,
    services: services.map(publicServiceRecord)
  };
}

export async function uninstallLaunchdServices(options = {}) {
  const uid = options.uid ?? currentUid();
  const domain = launchdDomain(uid);
  const services = resolveLaunchdServices(options);

  for (const service of services) {
    if (options.load !== false) {
      await runLaunchctl(["bootout", `${domain}/${service.label}`], {
        ...options,
        allowFailure: true
      });
    }
    await rm(service.plistPath, { force: true });
  }

  return {
    ok: true,
    domain,
    services: services.map(publicServiceRecord)
  };
}

export async function statusLaunchdServices(options = {}) {
  const uid = options.uid ?? currentUid();
  const domain = launchdDomain(uid);
  const services = resolveLaunchdServices(options);
  const status = [];

  for (const service of services) {
    const result = await runLaunchctl(["print", `${domain}/${service.label}`], {
      ...options,
      allowFailure: true
    });
    status.push({
      ...publicServiceRecord(service),
      loaded: result.ok,
      state: result.ok ? parseLaunchdState(result.stdout) : "not-loaded",
      message: result.ok ? "" : trimOutput(result.stderr || result.stdout || result.message)
    });
  }

  return {
    ok: true,
    domain,
    services: status
  };
}

export function createLaunchdPlist(service) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(service.label)}</string>
  <key>ProgramArguments</key>
  <array>
${service.programArguments.map((item) => `    <string>${xmlEscape(item)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(service.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(service.environment).map(([key, value]) => `    <key>${xmlEscape(key)}</key>
    <string>${xmlEscape(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(service.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(service.stderrPath)}</string>
</dict>
</plist>
`;
}

export function normalizeLaunchdTargets(target) {
  const requested = Array.isArray(target) ? target : String(target).split(",");
  const expanded = requested.flatMap((item) => item.trim() === "all" ? TARGETS : [item.trim()]);
  const unique = [...new Set(expanded.filter(Boolean))];
  for (const item of unique) {
    if (!TARGETS.includes(item)) {
      throw new Error(`unknown launchd target: ${item}`);
    }
  }
  return unique.length > 0 ? unique : [...TARGETS];
}

export function launchdLogPaths(options = {}) {
  return {
    ok: true,
    services: resolveLaunchdServices(options).map((service) => ({
      name: service.name,
      label: service.label,
      stdoutPath: service.stdoutPath,
      stderrPath: service.stderrPath
    }))
  };
}

async function prepareLaunchdFilesystem(services) {
  const dirs = new Set();
  for (const service of services) {
    dirs.add(dirname(service.plistPath));
    dirs.add(dirname(service.stdoutPath));
    dirs.add(dirname(service.stderrPath));
  }
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

async function runLaunchctl(args, options = {}) {
  const runCommand = options.runCommand ?? execFileAsync;
  try {
    const result = await runCommand("launchctl", args, { maxBuffer: 1024 * 1024 });
    return { ok: true, args, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const result = {
      ok: false,
      args,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      message: error.message
    };
    if (options.allowFailure) return result;
    throw new Error(`launchctl ${args.join(" ")} failed: ${trimOutput(result.stderr || result.stdout || result.message)}`);
  }
}

function publicServiceRecord(service) {
  return {
    name: service.name,
    label: service.label,
    plistPath: service.plistPath,
    stdoutPath: service.stdoutPath,
    stderrPath: service.stderrPath
  };
}

function parseLaunchdState(output) {
  const match = /state = ([^\n]+)/.exec(output);
  return match ? match[1].trim() : "loaded";
}

function launchdDomain(uid) {
  return `gui/${uid}`;
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    throw new Error("launchd service management requires a local macOS user uid");
  }
  return process.getuid();
}

function defaultPathEnv(nodePath, homeDir) {
  const nodeDir = dirname(nodePath);
  return [
    nodeDir,
    join(homeDir, ".local/bin"),
    "/Applications/Codex.app/Contents/Resources",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
}

function trimOutput(value) {
  return String(value ?? "").trim().slice(0, 2000);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
