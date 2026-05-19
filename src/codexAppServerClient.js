import { JsonlRpcClient } from "./jsonlRpcClient.js";

export class CodexAppServerClient {
  constructor(options = {}) {
    this.client = new JsonlRpcClient("codex", ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd,
      env: options.env,
      onStderr: options.onStderr,
      onNotification: options.onNotification
    });
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return null;
    const result = await this.client.request("initialize", {
      clientInfo: {
        name: "codex-butler",
        title: "Codex Butler",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "thread/started",
          "warning",
          "mcpServer/startupStatus/updated"
        ]
      }
    });
    this.client.notify("initialized");
    this.initialized = true;
    return result;
  }

  async startEphemeralThread(cwd) {
    await this.initialize();
    return this.client.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });
  }

  async commandExec(params) {
    await this.initialize();
    return this.client.request("command/exec", params, params.timeoutMs ? params.timeoutMs + 5000 : 15000);
  }

  async runReadOnlyWriteProbe(cwd, targetPath) {
    const script = [
      `touch ${shellQuote(targetPath)} 2>&1`,
      `test -e ${shellQuote(targetPath)} && echo EXISTS || echo ABSENT`
    ].join("; ");
    const result = await this.commandExec({
      command: ["/bin/sh", "-lc", script],
      cwd,
      timeoutMs: 5000,
      sandboxPolicy: { type: "readOnly", networkAccess: false }
    });
    return {
      denied: result.stdout.includes("ABSENT"),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  close() {
    this.client.close();
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
