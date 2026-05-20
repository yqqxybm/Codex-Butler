# Runbook

## Local Smoke

```sh
npm run smoke
```

Expected result:

- syntax check passes,
- unit tests pass,
- app-server probe reports `ok: true`.

## Capability Probe Only

```sh
npm run probe
```

The probe is safe. It creates only ephemeral app-server state and attempts a
read-only sandbox write to a temporary path. The expected result is that the
write is denied.

## Worker Turn Probe

```sh
npm run probe:turn
```

This performs the normal capability probe and additionally starts a real
`turn/start` with an `outputSchema`. It uses the model, so keep it out of cheap
local smoke unless the worker-session path changed.

## Butler CLI

```sh
npm run butler -- submit-goal "ship a feature"
npm run butler -- plan-goal "ship a feature"
npm run butler -- create-task <goal-id> verifier "run smoke checks"
npm run butler -- status
npm run butler -- dashboard
```

State and ledger files are stored under `.codex-butler/`, which is intentionally
ignored by git.

## Butler Daemon

```sh
npm run daemon -- start
npm run daemon -- status
npm run daemon -- stop
npm run daemon -- run
```

`start` launches a detached local `codex-butlerd` worker. `run` keeps the
daemon in the foreground for process managers. Status is recorded in
`.codex-butler/daemon.json` with PID and heartbeat fields.

## MCP Server

```sh
npm run mcp
```

Use this command as the stdio MCP server entrypoint for Butler sessions. The
server exposes goal, task, dispatch, worktree, verifier, promotion, status, and
ledger tools, plus planning, dashboard, and daemon management tools.

## Web Console

```sh
npm run web -- --host 127.0.0.1 --port 4177
```

Open `http://127.0.0.1:4177`. The web console is a local operator UI for goal
planning, daemon control, task action buttons, status metrics, and recent ledger
events. It binds to localhost by default.

## Planning And Dashboard

```sh
npm run butler -- plan-goal "Build a CLI dashboard and tests"
npm run butler -- dashboard
```

`plan-goal` creates one goal and ordered role-owned tasks. Implementation goals
produce iteration, review, verifier, and promoter tasks. Review-only goals
produce review and verifier tasks. Later tasks carry prerequisites and gate
tasks carry `targetTaskId`, so the Butler session can tell which prior task is
being reviewed, verified, or promoted.

## Transcript Evidence

Worker handoff validation reads app-server turn notifications. A required skill
is accepted as `externally-verified` only when the transcript contains a
successful command/tool record that references that skill's `SKILL.md`. Model
claims such as "I read the skill" are not enough.

## Common Failures

### `codex` Not Found

Install or expose the Codex CLI on `PATH`.

### `initialize` Timeout

Use stdio app-server mode, not the unix socket proxy:

```sh
codex app-server --listen stdio://
```

The unix socket proxy carries websocket frames and is not the current client
path used by this project.

### Read-only Write Is Not Denied

Treat this as a release blocker. The Butler design depends on sandbox policy
being enforceable before worker sessions can be trusted with task execution.

### Worker Turn Probe Fails

Treat this as a transport blocker. The product requires true app-server turns,
not only thread creation or standalone command execution.

### Promotion Is Blocked By Dirty Main Workspace

Commit, stash, or intentionally clear unrelated main-workspace changes before
promotion. The promotion gate refuses to apply worker diffs into a dirty main
workspace.

### Daemon Status Is `stale`

The recorded PID no longer exists. Run:

```sh
npm run daemon -- stop
npm run daemon -- start
```

## Evidence Rules

- `declared`: model says it did something.
- `prompt-constrained`: prompt required the behavior.
- `transcript-supported`: transcript shows the behavior.
- `externally-verified`: service or command evidence confirms it.

Only `externally-verified` may be reported as verified.
