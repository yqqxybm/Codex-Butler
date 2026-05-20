# Architecture

## Target Shape

```text
User
  -> Butler Codex Session
  -> codex-butler MCP tools
  -> codex-butlerd deterministic service
  -> Codex worker sessions
  -> review / verifier / promotion gates
```

## Principles

1. Butler is a controller, not a direct executor.
2. Worker output is untrusted until validated by the service.
3. The main workspace is modified only by a deterministic promotion gate.
4. `codex exec` may test protocol contracts, but true product behavior requires
   app-server threads.
5. Evidence levels are explicit: `declared`, `prompt-constrained`,
   `transcript-supported`, and `externally-verified`.

## Components

### App Server Client

Uses `codex app-server --listen stdio://` with newline-delimited JSON-RPC
messages. The wire format omits the `jsonrpc` field, matching Codex app-server
documentation.

Current implementation validates:

- initialize / initialized handshake,
- ephemeral thread creation,
- real `turn/start` with `outputSchema` when `probe:turn` is requested,
- standalone command execution,
- read-only sandbox denial.

### Capability Probe

Checks the local Codex CLI, app-server daemon metadata, generated schema bundle,
global config risks, and runtime sandbox behavior.

### Butler Service

`ButlerService` is the deterministic control-plane core. It owns goal/task
state, append-only ledger writes, natural-language plan compilation, worker
dispatch, worktree allocation, verification, promotion, dashboard rendering,
daemon status, and operational status. The model-facing Butler session should
call this service through MCP tools instead of writing project files directly.

### Daemon Management

`src/daemon.js` manages the local `codex-butlerd` process with
start/status/stop/run semantics. The daemon records PID and heartbeat state
under `.codex-butler/daemon.json`; stale PID detection is deterministic and
tested.

### Plan Compiler

`src/planCompiler.js` turns a natural-language goal into ordered role-owned
tasks. It keeps review-only requests out of implementation roles, adds verifier
and promoter tasks for implementation work, and records prerequisites so the
Butler session has an explicit execution graph. Gate tasks carry `targetTaskId`
links back to the implementation or review task they verify or promote.

### Transcript Evidence

`src/evidence.js` scans app-server turn notifications for successful command or
tool records that read the required skill's `SKILL.md`. Worker self-report can
remain `declared` or `transcript-supported`, but only external transcript
evidence can upgrade a required skill read to `externally-verified`.

### MCP Server

`src/mcpServer.js` uses the official Model Context Protocol SDK and exposes
Butler tools over stdio. This is the integration surface for a Butler Codex
session.

### Dashboard

`src/dashboard.js` renders a human-readable operational dashboard with goal
counts, task states, active work, and recent ledger events. CLI and MCP expose
the same status surface.

### Web Console

`src/webServer.js` serves a localhost-only web console and JSON API over Node's
built-in HTTP server. The UI is static HTML/CSS/JavaScript under `web/` and
calls the same `ButlerService` methods as CLI and MCP. The web layer is a local
operator surface; it does not bypass service-side state transitions, worktree
allocation, verifier gates, or promotion rules.

### Ledger

Append-only JSONL events. Each event has a stable event id, timestamp, type, and
payload. The ledger is the recovery and audit source for the Butler control
plane.

### State Machine

Goal states:

```text
intake -> planned -> running -> reviewing -> promoting -> done
```

Blocked and failed states are terminal until a new event reopens work.

Task states:

```text
queued -> leased -> dispatched -> awaiting_result -> validating
        -> review -> verified -> promoted
```

Rework loops return from `review` or `validating` to `queued`.

### Worktrees And Promotion

Implementation tasks can receive isolated git worktrees under
`.codex-butler/worktrees/`. Promotion requires a verified task and a clean main
workspace. The gate applies the task worktree diff deterministically with
`git apply`, including staged and untracked files; it does not let the model
write the main workspace directly.

### Role Contracts

Every worker receives a role contract:

- role,
- required skill,
- owned scope,
- forbidden actions,
- expected output schema,
- evidence requirements.

Workers cannot ask the user directly, write the main workspace, promote changes,
or claim unverified success.

Worker turns are read-only by default. If a task has an allocated worktree, the
turn runs in `workspaceWrite` sandbox mode with `writableRoots` restricted to
that worktree.

## Completion Boundary

The current repository implements the local deterministic Butler control plane:
transport probes, daemon management, planning, MCP tools, dispatch, transcript
evidence extraction, worktree allocation, verification, promotion, dashboard,
local web console, tests, and runbook. Remote deployment, a native desktop GUI,
and hosted release packaging are outside this repository's current
local-control-plane boundary.
