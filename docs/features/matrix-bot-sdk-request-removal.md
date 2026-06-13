---
tags:
  - status/complete
---

# Matrix Bot SDK Request Removal Fallback

## Goal

Remove `request` and `request-promise` from UMG production dependencies.

Completed by adopting the [mautrix transport spike](matrix-mautrix-transport.md), not by patching `matrix-bot-sdk`.

## Outcome

- `mautrix` is now the default Matrix adapter.
- `matrix-bot-sdk` remains only as a dev/test dependency for Matrix smoke control clients and legacy helper tests.
- `npm audit --omit=dev` reports no production vulnerabilities.
- Production Matrix state is `mautrix-crypto.db` instead of `matrix-crypto/` and `matrix-store.json`.

## Non-goals

- Replace `matrix-bot-sdk` with `matrix-js-sdk`.
- Add Matrix features.
- Change UMG envelopes or gateway protocol.
- Change downstream consumer routing.

## Implementation notes

No `matrix-bot-sdk` fork was needed. Keep the fork/patch idea only as historical fallback rationale.

## Acceptance

- `npm audit --omit=dev` has no `request`-chain findings.
- `npm ls request request-promise request-promise-core --omit=dev` has no production paths.
- `npm run typecheck`
- `npm run lint`
- `npm test`
- Live Matrix smoke passes for plaintext and encrypted rooms.
- Downstream stack Matrix smoke passes after update.

## Related

- [mautrix transport spike](matrix-mautrix-transport.md)
- [ADR 0015](../decisions/0015-adopt-mautrix-matrix-transport.md)
- [ADR 0014](../decisions/0014-spike-mautrix-matrix-transport.md)
- [ADR 0012](../decisions/0012-reject-matrix-js-sdk-node-e2ee-migration.md)
- [ADR 0013](../decisions/0013-patch-matrix-bot-sdk-request-chain.md)
