import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class EventLedger {
  constructor(path) {
    this.path = path;
  }

  async append(type, payload, metadata = {}) {
    await mkdir(dirname(this.path), { recursive: true });
    const event = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      payload,
      metadata
    };
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async readAll() {
    try {
      const text = await readFile(this.path, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}
