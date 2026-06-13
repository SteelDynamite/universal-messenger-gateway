# universal-messenger-gateway — Project State

Current active state: mautrix Matrix adoption is implemented; review/commit/deploy remains.

## Completed Matrix adoption state

- Default Matrix adapter: Python `mautrix` sidecar.
- TypeScript adapter: `src/transports/matrix-mautrix.ts`.
- Python sidecar: `src/transports/matrix-mautrix-sidecar.py`.
- Runtime deps: `requirements-mautrix.txt`.
- Matrix state: `mautrix-crypto.db` under the transport state dir.
- `matrix-bot-sdk`, `@matrix-org/matrix-sdk-crypto-nodejs`, and `request` are removed from production dependencies. `matrix-bot-sdk` remains dev-only for smoke control clients.
- Recovery-key import / cross-signing health are not required for the mautrix path; persistent encrypted restart decrypt is covered by live smoke.
- Live smoke covers plaintext, formatted text, encrypted send/receive, replies, threads, reactions, typing command path, invites, reject, leave, media metadata, group mention/member count, gateway JSON-lines path, process-exit shutdown, and encrypted decrypt after sidecar restart with stable SQLite crypto DB.

## Carry-forward

- Commit UMG, Forge docs, and pi-bot-stack packaging changes.
- Deploy/update pi-bot-stack after UMG is pushed.
- Observe first production Matrix run using `mautrix-crypto.db`.

## Known carry-forward notes

- Matrix audit follow-up now uses [ADR 0015](decisions/0015-adopt-mautrix-matrix-transport.md).
- Interactive chat mode uses a hard process exit on quit; see [tech-debt 0001](techdebt/0001-bun-matrix-crypto-hard-exit.md).
- Rich client behavior is tracked in [client capability backlog](features/client-capability-backlog.md) and [rich message capabilities](features/rich-message-capabilities.md).
- Local Matrix smoke-test state exists under gitignored `state/`. Do not commit `state/`.
