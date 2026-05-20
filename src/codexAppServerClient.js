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

  async startTurn({ threadId, inputText, outputSchema, timeoutMs = 180000 }) {
    await this.initialize();
    const start = await this.client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: inputText, text_elements: [] }],
      outputSchema,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      effort: "low"
    }, timeoutMs);
    const completed = await this.client.waitForNotification(
      (notification) => notification.method === "turn/completed"
        && notification.params?.threadId === threadId
        && notification.params?.turn?.id === start.turn?.id,
      timeoutMs
    );
    const finalAgentMessage = this.client.notifications
      .filter((notification) => notification.method === "item/completed"
        && notification.params?.threadId === threadId
        && notification.params?.turnId === start.turn?.id)
      .map((notification) => notification.params?.item)
      .find((item) => item?.type === "agentMessage" && item.phase === "final_answer");
    return {
      start,
      completed,
      finalText: finalAgentMessage?.text ?? null
    };
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

  async runStructuredTurnProbe(cwd) {
    const thread = await this.startEphemeralThread(cwd);
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["ok"] }
      }
    };
    const turn = await this.startTurn({
      threadId: thread.thread.id,
      inputText: "Return JSON with status ok. Do not run tools.",
      outputSchema
    });
    let parsed = null;
    try {
      parsed = turn.finalText ? JSON.parse(turn.finalText) : null;
    } catch {
      parsed = null;
    }
    return {
      ok: turn.completed.params?.turn?.status === "completed" && parsed?.status === "ok",
      threadId: thread.thread.id,
      turnId: turn.completed.params?.turn?.id ?? null,
      turnStatus: turn.completed.params?.turn?.status ?? null,
      finalText: turn.finalText,
      parsed
    };
  }

  close() {
    this.client.close();
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
