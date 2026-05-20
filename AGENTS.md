# AGENTS.md

## Project Intent

This project builds a deterministic control plane that lets one Butler Codex
session coordinate other Codex worker sessions without letting workers write the
main workspace, ask the user directly, or claim unverified completion.

## Local Rules

- Keep the Butler/service boundary explicit. The model may judge and route, but
  deterministic service code owns ledger, state transitions, workspace
  allocation, verification, and promotion.
- Do not treat `codex exec` as the product session transport. It is only a
  protocol or CI harness.
- Any claim about app-server capability must be backed by `npm run probe` or a
  more specific command.
- Any claim about worker-turn capability must be backed by `npm run probe:turn`.
- Any claim about MCP tool loading must be backed by the MCP protocol test or a
  real Codex MCP load.
- Any claim about daemon, planning, transcript evidence, or dashboard behavior
  must be backed by the corresponding unit test plus a CLI or MCP smoke command
  when practical.
- Worker prompts must include role, required skill, owned scope, forbidden
  actions, and output schema.
- Do not add dependencies unless they remove real implementation risk.

## Verification

- Syntax: `npm run check`
- Unit tests: `npm test`
- Local Codex capability probe: `npm run probe`
- Worker-turn probe: `npm run probe:turn`
- Full smoke: `npm run smoke`
- Daemon status smoke: `npm run daemon -- status`
- Dashboard smoke: `npm run butler -- dashboard`
- Web console smoke: `npm run web -- --port 4177`
- Persistent service smoke: `npm run launchd -- status`
