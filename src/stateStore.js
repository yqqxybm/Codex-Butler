import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class StateStore {
  constructor(path) {
    this.path = path;
  }

  async load() {
    try {
      return normalizeState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  async save(state) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
  }
}

function emptyState() {
  return { goals: {}, tasks: {}, sessions: {}, sessionRuns: {} };
}

function normalizeState(state) {
  return {
    ...emptyState(),
    ...state,
    goals: state?.goals ?? {},
    tasks: state?.tasks ?? {},
    sessions: state?.sessions ?? {},
    sessionRuns: state?.sessionRuns ?? {}
  };
}
