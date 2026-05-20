import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLaunchdPlist,
  installLaunchdServices,
  launchdLogPaths,
  normalizeLaunchdTargets,
  resolveLaunchdServices,
  statusLaunchdServices,
  uninstallLaunchdServices
} from "../src/launchd.js";

test("launchd target normalization expands all and rejects unknown services", () => {
  assert.deepEqual(normalizeLaunchdTargets("all"), ["daemon", "web"]);
  assert.deepEqual(normalizeLaunchdTargets("web,daemon,web"), ["web", "daemon"]);
  assert.throws(() => normalizeLaunchdTargets("worker"), /unknown launchd target/);
});

test("launchd service specs use absolute node, CLI, logs, and web bind arguments", () => {
  const services = resolveLaunchdServices({
    projectRoot: "/repo",
    homeDir: "/Users/test",
    nodePath: "/bin/node",
    pathEnv: "/bin:/usr/bin",
    host: "127.0.0.1",
    port: 4178
  });

  const daemon = services.find((service) => service.name === "daemon");
  const web = services.find((service) => service.name === "web");
  assert.deepEqual(daemon.programArguments.slice(0, 3), ["/bin/node", daemon.programArguments[1], "daemon"]);
  assert.deepEqual(web.programArguments.slice(-4), ["--host", "127.0.0.1", "--port", "4178"]);
  assert.equal(web.workingDirectory, "/repo");
  assert.equal(web.plistPath, "/Users/test/Library/LaunchAgents/com.codex-butler.web.plist");
  assert.equal(web.stdoutPath, "/repo/.codex-butler/logs/codex-butler-web.out.log");
});

test("launchd plist escapes values and keeps services alive", () => {
  const [service] = resolveLaunchdServices({
    projectRoot: "/repo & data",
    homeDir: "/Users/test",
    nodePath: "/bin/node",
    pathEnv: "/bin:/usr/bin",
    target: "web"
  });
  const plist = createLaunchdPlist(service);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(plist, /\/repo &amp; data/);
  assert.match(plist, /com\.codex-butler\.web/);
});

test("launchd install writes plist files and issues bootstrap commands", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "codex-butler-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-butler-project-"));
  const calls = [];
  const result = await installLaunchdServices({
    projectRoot,
    homeDir,
    nodePath: "/bin/node",
    pathEnv: "/bin:/usr/bin",
    target: "web",
    uid: 501,
    runCommand: fakeLaunchctl(calls)
  });

  assert.equal(result.ok, true);
  assert.equal(result.domain, "gui/501");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.args[0]), ["bootout", "bootstrap", "kickstart"]);

  const plist = await readFile(join(homeDir, "Library/LaunchAgents/com.codex-butler.web.plist"), "utf8");
  assert.match(plist, /<string>web<\/string>/);
});

test("launchd status reports not-loaded when launchctl print fails", async () => {
  const result = await statusLaunchdServices({
    projectRoot: "/repo",
    homeDir: "/Users/test",
    target: "daemon",
    uid: 501,
    runCommand: async () => {
      const error = new Error("not found");
      error.stderr = "Could not find service";
      throw error;
    }
  });

  assert.equal(result.services[0].loaded, false);
  assert.equal(result.services[0].state, "not-loaded");
});

test("launchd uninstall removes plist files after bootout", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "codex-butler-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-butler-project-"));
  await installLaunchdServices({
    projectRoot,
    homeDir,
    nodePath: "/bin/node",
    target: "daemon",
    uid: 501,
    load: false
  });

  const calls = [];
  const result = await uninstallLaunchdServices({
    projectRoot,
    homeDir,
    target: "daemon",
    uid: 501,
    runCommand: fakeLaunchctl(calls)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ["bootout", "gui/501/com.codex-butler.daemon"]);
  await assert.rejects(
    readFile(join(homeDir, "Library/LaunchAgents/com.codex-butler.daemon.plist"), "utf8"),
    /ENOENT/
  );
});

test("launchd log paths expose operational files without loading launchd", () => {
  const logs = launchdLogPaths({
    projectRoot: "/repo",
    homeDir: "/Users/test",
    target: "web"
  });
  assert.equal(logs.services[0].stdoutPath, "/repo/.codex-butler/logs/codex-butler-web.out.log");
  assert.equal(logs.services[0].stderrPath, "/repo/.codex-butler/logs/codex-butler-web.err.log");
});

function fakeLaunchctl(calls) {
  return async (command, args) => {
    calls.push({ command, args });
    return { stdout: "state = running\n", stderr: "" };
  };
}
