# Patch matrix-bot-sdk request chain fallback

## Context

UMG's Matrix transport uses `matrix-bot-sdk` with working encrypted-room behavior, recovery-key import, and cross-signing health.

`matrix-bot-sdk` pulls deprecated `request` and `request-promise`, causing production audit findings.

`matrix-js-sdk` is not currently viable for UMG normal runtime because persistent Node crypto storage is not ready.

## Options considered

### Keep `matrix-bot-sdk` unchanged

- Good: no behavior risk.
- Bad: keeps `request`-chain audit findings.

### Migrate to `matrix-js-sdk`

- Good: official SDK and no `request` chain.
- Bad: lacks a proven persistent Node crypto store for UMG.

### Patch or fork `matrix-bot-sdk`

- Good: removes the vulnerable HTTP stack with the smallest Matrix behavior delta.
- Good: preserves current crypto state and E2EE behavior.
- Bad: adds fork/patch maintenance.

### Write a raw Matrix client

- Good: maximum dependency control.
- Bad: much larger Matrix protocol and E2EE maintenance burden.

## Decision

Keep the `matrix-bot-sdk` patch/fork path as fallback if the `mautrix` sidecar spike fails.

If used, patch or fork `matrix-bot-sdk` to replace `request`/`request-promise` with `fetch`/`undici`, while keeping the SDK API used by UMG source-compatible.

## Consequences

- Do not implement this before [ADR 0014](0014-spike-mautrix-matrix-transport.md) unless the `mautrix` spike fails.
- If fallback is needed, UMG keeps its current Matrix transport shape and state paths.
- If fallback is needed, production dependencies should lose `request`, `request-promise`, and their transitive audit findings.
- The fork/patch must be verified by unit tests, live UMG Matrix smoke, and downstream stack Matrix smoke.

## Related

- [ADR 0014](0014-spike-mautrix-matrix-transport.md)
- [ADR 0012](0012-reject-matrix-js-sdk-node-e2ee-migration.md)
