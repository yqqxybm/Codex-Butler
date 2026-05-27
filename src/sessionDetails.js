import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TAIL_BYTES = 1024 * 1024;

export class SessionDetailReader {
  constructor(options = {}) {
    this.codexHome = options.codexHome ?? join(homedir(), ".codex");
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  }

  async enrichSessions(sessions) {
    const index = await this.readIndex();
    const transcriptPaths = await this.readTranscriptPaths();
    return Promise.all(sessions.map(async (session) => ({
      ...session,
      details: await this.readDetails(session, index.get(session.threadId), transcriptPaths.get(session.threadId))
    })));
  }

  async readDetails(session, indexEntry, transcriptPath) {
    const transcript = transcriptPath ? await readTranscriptSummary(transcriptPath, this.tailBytes) : {};
    return {
      threadName: indexEntry?.thread_name ?? null,
      updatedAt: indexEntry?.updated_at ?? transcript.updatedAt ?? session.updatedAt ?? null,
      transcriptPath: transcriptPath ?? null,
      transcriptFound: Boolean(transcriptPath),
      cwd: transcript.cwd ?? session.cwd ?? null,
      originator: transcript.originator ?? null,
      model: transcript.model ?? null,
      lastUserMessage: transcript.lastUserMessage ?? null,
      lastAssistantMessage: transcript.lastAssistantMessage ?? null,
      messageCount: transcript.messageCount ?? null
    };
  }

  async readIndex() {
    const index = new Map();
    const text = await readOptionalText(join(this.codexHome, "session_index.jsonl"));
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseJson(line);
      if (!parsed?.id) continue;
      const existing = index.get(parsed.id);
      if (!existing || String(parsed.updated_at ?? "") >= String(existing.updated_at ?? "")) {
        index.set(parsed.id, parsed);
      }
    }
    return index;
  }

  async readTranscriptPaths() {
    const root = join(this.codexHome, "sessions");
    const files = await listJsonlFiles(root);
    const paths = new Map();
    for (const path of files) {
      const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1];
      if (id && !paths.has(id)) paths.set(id, path);
    }
    return paths;
  }
}

async function listJsonlFiles(root) {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readTranscriptSummary(path, tailBytes) {
  const text = await readTailText(path, tailBytes);
  const summary = {
    updatedAt: null,
    cwd: null,
    originator: null,
    model: null,
    lastUserMessage: null,
    lastAssistantMessage: null,
    messageCount: 0
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = parseJson(line);
    if (!record) continue;
    if (record.timestamp) summary.updatedAt = record.timestamp;
    if (record.type === "session_meta") {
      summary.cwd = record.payload?.cwd ?? summary.cwd;
      summary.originator = record.payload?.originator ?? summary.originator;
      summary.model = record.payload?.model ?? record.payload?.model_slug ?? summary.model;
      continue;
    }
    const message = extractMessage(record);
    if (!message) continue;
    summary.messageCount += 1;
    if (message.role === "user") summary.lastUserMessage = message.text;
    if (message.role === "assistant") summary.lastAssistantMessage = message.text;
  }
  return summary;
}

function extractMessage(record) {
  if (record.type === "response_item" && record.payload?.type === "message") {
    return {
      role: record.payload.role,
      text: summarizeText(extractContentText(record.payload.content))
    };
  }
  if (record.type === "event_msg" && record.payload?.type === "user_message" && typeof record.payload?.message === "string") {
    return {
      role: "user",
      text: summarizeText(record.payload.message)
    };
  }
  return null;
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    return item?.text ?? item?.input_text ?? item?.output_text ?? "";
  }).filter(Boolean).join("\n");
}

function summarizeText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

async function readTailText(path, maxBytes) {
  const fileStat = await stat(path);
  const length = Math.min(fileStat.size, maxBytes);
  const start = Math.max(0, fileStat.size - length);
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } finally {
    await file.close();
  }
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
