import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class StateStore {
  constructor(path) {
    this.path = path;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return { goals: {}, tasks: {} };
      }
      throw error;
    }
  }

  async save(state) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
