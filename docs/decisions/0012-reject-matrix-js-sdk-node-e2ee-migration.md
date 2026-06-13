# Reject matrix-js-sdk Node E2EE migration for now

## Context

`matrix-bot-sdk` pulls the deprecated `request` chain. `matrix-js-sdk` removes that chain, but its supported Rust crypto stores are browser IndexedDB or Node in-memory.

UMG needs persistent crypto state in the Node/container runtime. Losing that state would create a new device on each restart and break encrypted-room reliability.

Phase-0 findings:

- `matrix-js-sdk` documentation says Node must use `useIndexedDB: false` unless an IndexedDB implementation exists, which is ephemeral in-memory crypto.
- Upstream issue `matrix-js-sdk#4769` tracks missing Node persistent crypto storage.
- `fake-indexeddb` is in-memory only.
- `indexeddb` is not maintained enough for production selection.
- `indexeddbshim` with a file-backed SQLite path fails `initRustCrypto({ useIndexedDB: true })` with `TransactionInactiveError` during Rust crypto store migration/open.

## Options considered

### Migrate now with in-memory crypto

- Good: removes `request` audit findings.
- Bad: creates new Matrix devices on restart and loses persistent crypto state.

### Migrate now with IndexedDBShim

- Good: intended file-backed IndexedDB shape.
- Bad: current Rust crypto initialization fails before sync.

### Keep `matrix-bot-sdk` until persistent Node crypto exists

- Good: preserves working encrypted-room behavior, recovery-key flow, and cross-signing health.
- Bad: keeps non-fixable `request` audit findings.

### Fork or replace Matrix client code

- Good: could remove the audit chain while preserving persistent crypto.
- Bad: larger maintenance burden.
- Outcome: patching/forking `matrix-bot-sdk` was selected next in [ADR 0013](0013-patch-matrix-bot-sdk-request-chain.md).

## Decision

Do not migrate UMG Matrix transport to `matrix-js-sdk` yet.

Keep `matrix-bot-sdk` and the existing `@matrix-org/matrix-sdk-crypto-nodejs` path for now. Remove the audit chain through the patch/fork path in [ADR 0013](0013-patch-matrix-bot-sdk-request-chain.md).

## Consequences

- UMG keeps current Matrix behavior and stack state paths.
- `npm audit` continues to report the inherited `request` chain.
- Do not use ephemeral `matrix-js-sdk` crypto for normal runtime.
- Revisit when `matrix-js-sdk` or its Rust crypto bindings support persistent Node storage, or when choosing a fork/custom-client option.
