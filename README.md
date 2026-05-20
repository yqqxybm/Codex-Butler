# codex-butler

`codex-butler` is a deterministic control plane for a Butler Codex session that
plans work, dispatches Codex worker sessions, validates handoffs, routes review,
and promotes verified changes.

The first vertical slice implements M0/M1:

- app-server JSONL transport probe,
- Codex schema and permission capability checks,
- read-only sandbox negative test,
- append-only event ledger,
- Goal/Task state machine,
- role prompt and worker output contracts,
- CLI smoke path.

## Why This Exists

The product goal is not "one long prompt". The goal is a controlled multi-session
system:

```text
user -> Butler Codex session -> codex-butler control plane
     -> worker sessions / review sessions / verifier / promoter
```

The Butler session decides and coordinates. The deterministic control plane owns
side effects, state, evidence, and promotion.

## Requirements

- Node.js 22 or newer.
- Codex CLI with `app-server` support.
- A local Codex account/config capable of starting app-server.

## Commands

```sh
npm run check
npm test
npm run probe
npm run probe:turn
npm run smoke
npm run butler -- status
npm run mcp
```

`npm run probe` starts a local `codex app-server --listen stdio://` subprocess,
initializes JSON-RPC, starts an ephemeral read-only thread, runs a safe command,
and verifies that a read-only sandbox blocks file creation.

`npm run probe:turn` additionally starts a real app-server `turn/start` with an
`outputSchema` and verifies the final model response. It is intentionally not
part of `npm run smoke` because it uses the model.

## Current Scope

Implemented:

- M0 transport and permission spike.
- Explicit worker-turn probe through `turn/start + outputSchema`.
- M1 deterministic contracts for ledger, state, and role handoffs.
- M2 persistent `codex-butlerd` service core through CLI/service APIs.
- M3 MCP stdio server with Butler tools.
- M4 worker dispatch over app-server `turn/start`.
- M5 isolated git worktree allocation.
- M6 verifier/rework state transitions.
- M7 deterministic promotion gate for verified worktree diffs.
- M8 status surface through CLI and MCP.

Not implemented yet:

- Long-running daemon process management.
- Automatic multi-task planning from a natural language goal.
- Full review-worker transcript evidence extraction for skill-read verification.
- UI dashboard beyond JSON status.

Those are intentionally separate phases so the control surface is testable
before worker automation starts modifying repositories.

## Butler Control Plane

```sh
npm run butler -- submit-goal "ship a feature"
npm run butler -- create-task <goal-id> verifier "run smoke checks"
npm run butler -- dispatch-task <task-id>
npm run butler -- verify-task <task-id> -- npm test
npm run butler -- promote-task <task-id>
npm run butler -- status
```

The MCP server exposes the same control-plane operations as tools:

- `butler_submit_goal`
- `butler_create_task`
- `butler_dispatch_task`
- `butler_allocate_worktree`
- `butler_run_verifier`
- `butler_promote_task`
- `butler_status`
- `butler_read_ledger`
