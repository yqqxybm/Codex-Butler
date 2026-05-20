import { spawn } from "node:child_process";

export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        settled = true;
        resolve({ exitCode: 124, stdout, stderr, timedOut: true });
      }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, timedOut: false });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
