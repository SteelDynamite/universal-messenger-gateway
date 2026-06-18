# Adopt mautrix Matrix transport

## Context

The `matrix-bot-sdk` Matrix transport worked, including encrypted rooms, but pulled the deprecated `request` chain into production dependencies.

The Python `mautrix` sidecar spike now passes live smoke for plaintext, encrypted rooms, replies, threads, reactions, typing command path, invites, reject, leave, media metadata, group member metadata, gateway JSON-lines, process-exit shutdown, and encrypted decrypt after sidecar restart with the same SQLite crypto DB.

## Options considered

### Keep `matrix-bot-sdk` as the default

- Good: already had recovery-key import and cross-signing health checks.
- Bad: keeps `request` in production dependencies.

### Make `mautrix` the default Matrix adapter

- Good: removes `matrix-bot-sdk` and `request` from production dependencies.
- Good: keeps persistent encrypted-room state in SQLite.
- Bad: recovery-key import and cross-signing health are not implemented in UMG.

### Wait for recovery-key import before adopting mautrix

- Good: preserves the old health story before switching.
- Bad: blocks removal of the production audit chain after live smoke proved the runtime behavior needed by pi-bot.

## Decision

Make the Python `mautrix` sidecar the default Matrix adapter.

Do not require recovery-key import or cross-signing health for adoption. Treat them as future health/observability enhancements rather than replacement blockers.

Remove `matrix-bot-sdk` and `@matrix-org/matrix-sdk-crypto-nodejs` from dependencies. Live smoke tests use a minimal REST control client instead of the SDK.

## Consequences

- UMG installs no longer include `matrix-bot-sdk` or `request`.
- Matrix runtime requires Python deps from `requirements-mautrix.txt`.
- pi-bot-stack installs those deps into the runtime tool venv.
- Matrix E2EE state now lives in `mautrix-crypto.db` for the default adapter.
- `matrix-recovery-key.txt` is no longer required by the default Matrix path.

## Related

- [mautrix feature spec](../features/matrix-mautrix-transport.md)
- [ADR 0014](0014-spike-mautrix-matrix-transport.md)
- [ADR 0013](0013-patch-matrix-bot-sdk-request-chain.md)
