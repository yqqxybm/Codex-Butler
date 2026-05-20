import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateWorktree, promoteWorktree } from "../src/worktree.js";
import { runCommand } from "../src/exec.js";

test("worktree promotion applies unstaged tracked diff to a clean main workspace", async () => {
  const repo = await initRepo();
  const allocated = await allocateWorktree(repo, "task-1");
  assert.equal(allocated.ok, true);
  await writeFile(join(allocated.path, "file.txt"), "after\n");

  const promoted = await promoteWorktree(repo, allocated.path);
  assert.equal(promoted.ok, true);
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "after\n");
});

test("worktree promotion applies staged tracked diff to a clean main workspace", async () => {
  const repo = await initRepo();
  const allocated = await allocateWorktree(repo, "task-2");
  assert.equal(allocated.ok, true);
  await writeFile(join(allocated.path, "file.txt"), "staged\n");
  await must("git", ["add", "file.txt"], allocated.path);

  const promoted = await promoteWorktree(repo, allocated.path);
  assert.equal(promoted.ok, true);
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "staged\n");
});

test("worktree promotion applies untracked files to a clean main workspace", async () => {
  const repo = await initRepo();
  const allocated = await allocateWorktree(repo, "task-3");
  assert.equal(allocated.ok, true);
  await writeFile(join(allocated.path, "new-file.txt"), "new\n");

  const promoted = await promoteWorktree(repo, allocated.path);
  assert.equal(promoted.ok, true);
  assert.equal(await readFile(join(repo, "new-file.txt"), "utf8"), "new\n");
});

async function initRepo() {
  const repo = await mkdtemp(join(tmpdir(), "codex-butler-repo-"));
  await must("git", ["init"], repo);
  await must("git", ["config", "user.email", "test@example.com"], repo);
  await must("git", ["config", "user.name", "Test User"], repo);
  await writeFile(join(repo, "file.txt"), "before\n");
  await must("git", ["add", "file.txt"], repo);
  await must("git", ["commit", "-m", "initial"], repo);
  return repo;
}

async function must(command, args, cwd) {
  const result = await runCommand(command, args, { cwd, timeoutMs: 30000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}
