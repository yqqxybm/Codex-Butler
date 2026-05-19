# 0001 Initial Architecture

## Status

Accepted.

## Context

The target product is a Codex session orchestration system. A user should talk to
one Butler Codex session, while the Butler coordinates specialized worker
sessions, validates results, routes review, and promotes only verified work.

Prompt-only orchestration is insufficient because the local default Codex
configuration may allow broad filesystem access. The system needs deterministic
service boundaries.

## Decision

Build `codex-butler` as a deterministic control plane:

- use app-server threads as the true session transport,
- keep `codex exec` limited to protocol harnesses,
- represent every goal and task with explicit state,
- record all side-effect decisions in an append-only ledger,
- require role contracts and structured worker outputs,
- perform verification and promotion outside worker self-reporting.

## Consequences

This adds implementation work before full automation, but it prevents the core
failure mode: a worker claiming completion or deep review without externally
verified evidence.
