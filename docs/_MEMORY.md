# universal-messenger-gateway — Project State

Current active state: mautrix Matrix adoption is implemented; an encrypted-DM recovery/debug patch is local and needs review/commit/deploy.

## Completed Matrix adoption state

- Default Matrix adapter: Python `mautrix` sidecar.
- TypeScript adapter: `src/transports/matrix-mautrix.ts`.
- Python sidecar: `src/transports/matrix-mautrix-sidecar.py`.
- Runtime deps: `requirements-mautrix.txt`.
- Matrix state: `mautrix-crypto.db` under the transport state dir.
- `matrix-bot-sdk`, `@matrix-org/matrix-sdk-crypto-nodejs`, and `request` are removed from production dependencies. `matrix-bot-sdk` remains dev-only for smoke control clients.
- Recovery-key import / cross-signing health are not required for the mautrix path; persistent encrypted restart decrypt is covered by live smoke.
- Missing Megolm sessions now wait for same-sync room-key delivery, then request the room key from the sender device and retry before surfacing a Matrix decryption error.
- When `matrix-recovery-key.txt` or `UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY` is present, the sidecar imports SSSS cross-signing secrets and self-signs the current device.
- Matrix E2EE health reports recovery-key, own identity trust, cross-signing identity, device signature, and own-device trust status.
- `UMG_MATRIX_DEBUG_ROOM_KEYS=1` logs credential-safe E2EE diagnostics for key upload, sync callbacks, to-device events, room keys, withheld keys, key requests, decrypt failures, and cross-signing import.
- Live smoke covers plaintext, formatted text, encrypted send/receive, replies, threads, reactions, typing command path, invites, reject, leave, media metadata, group mention/member count, gateway JSON-lines path, process-exit shutdown, and encrypted decrypt after sidecar restart with stable SQLite crypto DB.

## Carry-forward

- Commit UMG patch and Forge docs.
- Update/deploy pi-bot-stack after UMG is pushed.
- Observe production Matrix run with `UMG_MATRIX_DEBUG_ROOM_KEYS=1` temporarily enabled.

## Known carry-forward notes

- Matrix audit follow-up now uses [ADR 0015](decisions/0015-adopt-mautrix-matrix-transport.md).
- Interactive chat mode uses a hard process exit on quit; see [tech-debt 0001](techdebt/0001-bun-matrix-crypto-hard-exit.md).
- Rich client behavior is tracked in [client capability backlog](features/client-capability-backlog.md) and [rich message capabilities](features/rich-message-capabilities.md).
- Local Matrix smoke-test state exists under gitignored `state/`. Do not commit `state/`.
