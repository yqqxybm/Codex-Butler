import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./exec.js";

export const SESSION_RUN_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "user_decision", "actions", "risks"],
  properties: {
    status: {
      type: "string",
      enum: ["in_progress", "needs_user", "done", "blocked"]
    },
    summary: { type: "string" },
    user_decision: { type: "string" },
    actions: {
      type: "array",
      items: { type: "string" }
    },
    risks: {
      type: "array",
      items: { type: "string" }
    }
  }
});

export class CodexExecClient {
  constructor(options = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.dataDir = options.dataDir ?? join(this.cwd, ".codex-butler");
    this.command = options.command ?? "codex";
  }

  async resumeSession({ sessionId, prompt, runId, turnIndex, timeoutMs = 600000 }) {
    const artifactDir = join(this.dataDir, "artifacts", "session-runs");
    await mkdir(artifactDir, { recursive: true });
    const safeRunId = safeFilePart(runId);
    const schemaPath = join(artifactDir, `${safeRunId}-schema.json`);
    const outputPath = join(artifactDir, `${safeRunId}-turn-${turnIndex}.json`);
    await writeFile(schemaPath, `${JSON.stringify(SESSION_RUN_OUTPUT_SCHEMA, null, 2)}\n`, "utf8");
    const result = await runCommand(this.command, [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      sessionId,
      prompt
    ], {
      cwd: this.cwd,
      timeoutMs
    });
    const finalText = await readOptionalText(outputPath);
    const parsed = parseJson(finalText);
    return {
      ...result,
      outputPath,
      finalText,
      parsed
    };
  }
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}
