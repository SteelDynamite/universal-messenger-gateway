---
tags:
  - status/complete
---

# Matrix mautrix Transport Spike

## Goal

Prove whether a Python `mautrix` sidecar can replace the current `matrix-bot-sdk` Matrix transport while preserving UMG behavior and persistent E2EE.

## Current state

A minimal TypeScript-spawned Python sidecar exists:

- `src/transports/matrix-mautrix.ts` starts the sidecar and speaks local JSON-lines.
- `src/transports/matrix-mautrix-sidecar.py` owns Matrix sync, send/receive, and SQLite E2EE state.
- It is the default Matrix adapter; `implementation=mautrix` or `adapter=mautrix` are accepted but no longer required.
- Python deps are listed in `requirements-mautrix.txt`.
- State lives under the configured transport state dir as `mautrix-crypto.db`.

Do not start by patching `matrix-bot-sdk` unless this spike fails.

## Required behavior parity

- Inbound text messages.
- Outbound text messages.
- Direct replies and reply fallback parsing.
- Matrix threads and `threadTo` distinct from `replyTo`.
- Reactions.
- Typing notifications.
- Invites and accept-invite command behavior.
- Member count / group-chat metadata.
- Media attachment metadata.
- Decryption failures reported without crashing.
- Persistent encrypted-room decrypt after restart.

## Expected Python stack

- `mautrix[encryption]==0.21.0`
- `aiosqlite`
- `asyncpg` if required by mautrix store plumbing
- `python-olm` / libolm wheel or system package
- SQLite crypto DB under the UMG state directory

## Spike findings so far

- `mautrix[encryption]==0.21.0`, `aiosqlite==0.22.1`, and `asyncpg==0.31.0` installed locally on Linux/Python 3.11.
- `python-olm` installed from a manylinux wheel in that environment.
- `PgCryptoStore` opened `sqlite:///.../crypto.db` and persisted a device id in a no-network check.
- `mautrix` has typed support for `m.thread`, reactions, media upload/download, media metadata, and joined member lookup.
- Live sidecar smoke proved plaintext send/receive.
- Live sidecar smoke proved encrypted-room send/receive and decrypt after sidecar restart with the same SQLite crypto DB.
- For reliable live smoke, use account-password login so each run gets fresh device IDs and state paths; stale token/device state caused missing Megolm sessions.

## Parity checklist

- Done: inbound text messages.
- Done: outbound text messages.
- Done: formatted outbound text body through TypeScript adapter.
- Done: invites and explicit accept.
- Done: persistent encrypted-room decrypt after restart.
- Done: direct replies and reply fallback parsing.
- Done: Matrix threads and `threadTo` distinct from `replyTo`.
- Done: reactions.
- Done: typing command path.
- Done: media attachment metadata.
- Done: member count / group-chat metadata.
- Done: reject invite.
- Done: leave.
- Done: gateway JSON-lines send/event path.
- Done: process-exit shutdown clears connection state.
- Done: mautrix decryption warnings are normalized to UMG errors.
- Done: missing Megolm sessions wait briefly for same-sync room-key delivery, then request the room key from the sender device and retry before reporting a decryption error.
- Done: `UMG_MATRIX_DEBUG_ROOM_KEYS=1` logs credential-safe E2EE diagnostics for key upload, sync callbacks, to-device room-key events, withheld keys, key requests, and decrypt failures.
- Done: pi-bot-stack installs `requirements-mautrix.txt` into the runtime tool venv and verifies imports.
- Done: `matrix-bot-sdk` and `request` are removed from production dependencies.
- Decision: recovery-key import and cross-signing health are not required for the mautrix path; mautrix persists Olm/Megolm state in SQLite and smoke proves encrypted restart decrypt.

## Acceptance

- Minimal sidecar starts/stops cleanly from TypeScript.
- Sidecar state lives under the configured UMG state directory.
- Live Matrix plaintext smoke passes for the sidecar path.
- Live Matrix encrypted restart smoke passes for the sidecar path.
- `npm audit --omit=dev` reports no production vulnerabilities from `matrix-bot-sdk`/`request`.

## Related

- [ADR 0015](../decisions/0015-adopt-mautrix-matrix-transport.md)
- [ADR 0014](../decisions/0014-spike-mautrix-matrix-transport.md)
- [ADR 0012](../decisions/0012-reject-matrix-js-sdk-node-e2ee-migration.md)
- [ADR 0013](../decisions/0013-patch-matrix-bot-sdk-request-chain.md)
