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

## Evidence Rules

- `declared`: model says it did something.
- `prompt-constrained`: prompt required the behavior.
- `transcript-supported`: transcript shows the behavior.
- `externally-verified`: service or command evidence confirms it.

Only `externally-verified` may be reported as verified.
