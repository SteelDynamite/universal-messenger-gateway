# Spike mautrix Matrix transport

## Context

The current Matrix transport works with `matrix-bot-sdk`, but that SDK pulls deprecated `request` dependencies.

`matrix-js-sdk` is not viable for normal UMG runtime until persistent Node crypto storage is available.

Hermes Agent uses Python `mautrix[encryption]`, `OlmMachine`, and SQLite crypto storage. Local no-network checks showed `mautrix[encryption]==0.21.0` installs on Linux/Python 3.11 and can open a SQLite `PgCryptoStore`.

## Options considered

### Patch or fork `matrix-bot-sdk`

- Good: smallest change to current TypeScript transport.
- Bad: maintains a fork around deprecated internals.

### Add a Python mautrix sidecar

- Good: persistent SQLite E2EE state.
- Good: removes `matrix-bot-sdk` and `request` if adopted.
- Bad: adds Python packaging and sidecar lifecycle work.

### Wait for `matrix-js-sdk` persistent Node crypto

- Good: official JS SDK path.
- Bad: no current implementation path.

## Decision

Run the next implementation spike as a TypeScript-spawned Python `mautrix` sidecar transport.

Keep the `matrix-bot-sdk` patch/fork path as fallback if the `mautrix` spike fails.

## Consequences

- The public UMG SDK/protocol remains TypeScript-owned.
- The sidecar owns Matrix sync, E2EE, and SQLite crypto state during the spike.
- Live Matrix smoke parity decides whether this replaces the current Matrix transport.

## Related

- [ADR 0012](0012-reject-matrix-js-sdk-node-e2ee-migration.md)
- [ADR 0013](0013-patch-matrix-bot-sdk-request-chain.md)
- [mautrix feature spec](../features/matrix-mautrix-transport.md)
