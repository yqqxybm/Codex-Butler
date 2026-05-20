import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./exec.js";

export async function allocateWorktree(projectRoot, taskId, worktreeRoot = join(projectRoot, ".codex-butler", "worktrees")) {
  const safeTaskId = sanitizeId(taskId);
  const path = join(worktreeRoot, safeTaskId);
  const root = await git(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (root.exitCode !== 0) {
    return { ok: false, error: root.stderr.trim() || "not a git repository" };
  }
  if (existsSync(path)) {
    return { ok: true, path, reused: true };
  }
  await mkdir(worktreeRoot, { recursive: true });
  const added = await git(projectRoot, ["worktree", "add", "--detach", path, "HEAD"], 30000);
  return {
    ok: added.exitCode === 0,
    path,
    reused: false,
    stdout: added.stdout.trim(),
    stderr: added.stderr.trim()
  };
}

export async function promoteWorktree(projectRoot, worktreePath) {
  const status = await git(projectRoot, ["status", "--short", "--untracked-files=no"]);
  if (status.exitCode !== 0) {
    return { ok: false, error: status.stderr.trim() };
  }
  if (status.stdout.trim()) {
    return { ok: false, error: "main workspace is not clean", status: status.stdout.trim() };
  }

  const untracked = await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.exitCode !== 0) {
    return { ok: false, error: untracked.stderr.trim() };
  }
  const untrackedFiles = untracked.stdout.split("\0").filter(Boolean);
  if (untrackedFiles.length > 0) {
    const intentToAdd = await git(worktreePath, ["add", "-N", "--", ...untrackedFiles], 30000);
    if (intentToAdd.exitCode !== 0) {
      return { ok: false, error: intentToAdd.stderr.trim() || intentToAdd.stdout.trim() };
    }
  }

  const diff = await git(worktreePath, ["diff", "--binary", "HEAD"]);
  if (diff.exitCode !== 0) {
    return { ok: false, error: diff.stderr.trim() };
  }
  if (!diff.stdout.trim()) {
    return { ok: true, promoted: false, reason: "worktree has no diff" };
  }

  const check = await git(projectRoot, ["apply", "--check", "-"], 30000, diff.stdout);
  if (check.exitCode !== 0) {
    return { ok: false, error: check.stderr.trim() || check.stdout.trim() };
  }
  const applied = await git(projectRoot, ["apply", "-"], 30000, diff.stdout);
  return {
    ok: applied.exitCode === 0,
    promoted: applied.exitCode === 0,
    stdout: applied.stdout.trim(),
    stderr: applied.stderr.trim()
  };
}

async function git(cwd, args, timeoutMs = 10000, input = null) {
  return runCommand("git", args, { cwd, timeoutMs, input });
}

function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, "-");
}
