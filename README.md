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

Not implemented yet:

- Persistent `codex-butlerd` daemon.
- MCP tool server exposed to a Butler session.
- Full worker lifecycle with rework/review/promotion routing.
- Worktree allocation and deterministic promotion.

Those are intentionally separate phases so the control surface is testable
before worker automation starts modifying repositories.
