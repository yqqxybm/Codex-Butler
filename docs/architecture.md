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
- standalone command execution,
- read-only sandbox denial.

### Capability Probe

Checks the local Codex CLI, app-server daemon metadata, generated schema bundle,
global config risks, and runtime sandbox behavior.

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

1. Implement `codex-butlerd` as a persistent service.
2. Expose MCP tools for Butler sessions.
3. Add app-server worker turn lifecycle and structured model output.
4. Add worktree allocator.
5. Add review/rework/promotion gates.
