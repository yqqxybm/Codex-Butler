import { spawn } from "node:child_process";

export class JsonlRpcClient {
  constructor(command, args, options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = "";
    this.closed = false;
    this.child = null;
  }

  start() {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      if (this.options.onStderr) this.options.onStderr(chunk);
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`JSONL RPC process exited: code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  async request(method, params = undefined, timeoutMs = 15000) {
    this.start();
    const id = this.nextId++;
    this.#write({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method, params = undefined) {
    this.start();
    this.#write({ method, params });
  }

  close() {
    if (!this.child || this.closed) return;
    this.child.kill();
    this.closed = true;
  }

  #write(message) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("JSONL RPC process is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.notifications.push(message);
      if (this.options.onNotification) this.options.onNotification(message);
    }
  }
}
