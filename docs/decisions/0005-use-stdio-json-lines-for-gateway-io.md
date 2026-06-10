# Use stdio JSON-lines for gateway I/O

## Context

The Phase 1 cli exists to prove the gateway works independently from any future larger
structure. It is a test harness, not a durable admin client or user-facing product.

A unix socket would let a gateway process stay alive while clients connect and disconnect,
but that solves a lifecycle problem that has not appeared yet.

## Decision

Use newline-delimited JSON over stdio for Phase 1 gateway I/O.

The cli starts the gateway process, sends `GatewayCommand` objects on stdin, and reads
`GatewayEvent` objects from stdout. Gateway-mode stdout is reserved for JSON-lines
events; logs go to stderr. The envelope is defined in `src/protocol.ts`.

Do not add daemon or socket behavior unless an actual consumer or transport problem makes
process lifetime a proven requirement.

## Consequences

- The cli stays disposable and focused on exercising the gateway contract.
- The gateway can be tested with ordinary process streams.
- Phase 1 avoids socket paths, daemon lifecycle, stale socket cleanup, and reconnect rules.
- If Matrix session continuity or a future orchestrator needs a long-lived gateway, revisit
  the process boundary with that concrete requirement in hand.
