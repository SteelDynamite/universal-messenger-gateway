# Matrix smoke room-key sharing failure

## Problem

Live Matrix smoke failed before the first encrypted round-trip when it reused long-lived access
tokens from `state/matrix-smoke.env`. Account A encrypted the first message after account B
accepted the invite, but account B could not decrypt it.

## Finding

Room-key diagnostics showed two different flows:

- Reused access-token devices: A sent `m.room_key.withheld` to B with
  `code:m.no_olm` and `reason:Unable to establish a secure channel.`
- Fresh per-run password-login devices: A sent `m.room.encrypted` to-device payloads that B
  decrypted into `m.room_key`, after which the smoke round-trip passed.

The root cause was stale/reused Matrix device state for the smoke accounts, not chat input
editing and not a simple post-join timing race.

## Fix

The UMG and pi-bot smoke tests use account passwords, when present, to password-login smoke
accounts with fresh per-run devices and fresh per-run state directories. Access-token-only smoke config
still works as a fallback, but may reproduce stale-device E2EE failures.

`UMG_MATRIX_DEBUG_ROOM_KEYS=1` enables credential-safe room-key diagnostics for future failures.
It logs to-device event types, target user/device IDs, and withheld reason/code, but not access
tokens or room session keys.

## Verification

Passed locally with live Matrix smoke after fresh per-run login:

```sh
set -a && source state/matrix-smoke.env && set +a && \
  UMG_MATRIX_DEBUG_ROOM_KEYS=1 UMG_MATRIX_SMOKE=1 npm run test:matrix-smoke
```
