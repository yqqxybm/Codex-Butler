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
state, append-only ledger writes, worker dispatch, worktree allocation,
verification, promotion, and status. The model-facing Butler session should call
this service through MCP tools instead of writing project files directly.

### MCP Server

`src/mcpServer.js` uses the official Model Context Protocol SDK and exposes
Butler tools over stdio. This is the integration surface for a Butler Codex
session.

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

## Next Phases

1. Add long-running daemon process management around `ButlerService`.
2. Add automatic plan compilation from a natural language goal.
3. Add transcript-based skill-read evidence extraction.
4. Add richer dashboard output beyond JSON status.
