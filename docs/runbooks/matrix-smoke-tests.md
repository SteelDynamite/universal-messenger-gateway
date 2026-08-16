# Matrix Smoke Tests

Run live Matrix round-trips between three controlled test accounts.

## Requirements

- Three Matrix accounts on a homeserver that allows private encrypted rooms.
- Access tokens for all accounts.
- Optional account passwords. Password variables are recommended so live smoke can create fresh devices.
- A gitignored state directory; defaults to `state/matrix-smoke/`.

The runner stores each account under a state subdirectory derived from its Matrix user ID. This
prevents stale crypto stores from one account being reused with another account's access token.

## Command

Use the gitignored local env file when it exists. In the Forge workspace, it exists at `repos/universal-messenger-gateway/state/matrix-smoke.env`.

```sh
set -a && source state/matrix-smoke.env && set +a && UMG_MATRIX_SMOKE=1 npm run test:matrix-smoke
```

Or export the variables directly:

```sh
UMG_MATRIX_SMOKE=1 \
UMG_MATRIX_HOMESERVER_URL=https://matrix.example \
UMG_MATRIX_A_ACCESS_TOKEN=... \
UMG_MATRIX_B_ACCESS_TOKEN=... \
UMG_MATRIX_C_ACCESS_TOKEN=... \
npm run test:matrix-smoke
```

Optional variables:

- `UMG_MATRIX_SMOKE_STATE_DIR` — defaults to `state/matrix-smoke`.
- `UMG_MATRIX_A_ACCOUNT_PASSWORD`, `UMG_MATRIX_B_ACCOUNT_PASSWORD`, and
  `UMG_MATRIX_C_ACCOUNT_PASSWORD`.
- `UMG_MATRIX_A_RECOVERY_KEY`, `UMG_MATRIX_B_RECOVERY_KEY`, and
  `UMG_MATRIX_C_RECOVERY_KEY` — enable recovery-key import and device-trust assertions.
- `UMG_MATRIX_MAUTRIX_PYTHON` — Python executable with `requirements-mautrix.txt` installed. In pi-bot-stack this is available through the runtime PATH; local development usually sets this to a venv Python.
- `UMG_MATRIX_DEBUG_ROOM_KEYS=1` — logs credential-safe mautrix E2EE diagnostics: key upload, sync callbacks, to-device event types, room keys, withheld keys, key requests, decrypt failures, and cross-signing import.

## Python mautrix setup

The default Matrix adapter is the Python `mautrix` sidecar. Install Python deps in a venv for local live smoke:

```sh
python3 -m venv /tmp/umg-mautrix-venv
/tmp/umg-mautrix-venv/bin/pip install -r requirements-mautrix.txt
set -a && source state/matrix-smoke.env && set +a && \
  UMG_MATRIX_SMOKE=1 \
  UMG_MATRIX_MAUTRIX_SMOKE=1 \
  UMG_MATRIX_MAUTRIX_PYTHON=/tmp/umg-mautrix-venv/bin/python \
  npx vitest run tests/matrix-mautrix-smoke.test.ts
```

The focused mautrix smoke uses accounts A, B, and C. Password variables are recommended so each run logs in with fresh device IDs and avoids stale crypto state.

Focused mautrix smoke command:

```sh
set -a && source state/matrix-smoke.env && set +a && \
  UMG_MATRIX_SMOKE=1 \
  UMG_MATRIX_MAUTRIX_SMOKE=1 \
  UMG_MATRIX_MAUTRIX_PYTHON=/tmp/umg-mautrix-venv/bin/python \
  npx vitest run tests/matrix-mautrix-smoke.test.ts
```

Current default Matrix smoke coverage:

- Plaintext Matrix send/receive through UMG-shaped messages.
- Sanitized GFM outbound text, including code-block table fallbacks, task lists, and linked image alt text.
- Invite accept and reject.
- Encrypted Matrix send/receive.
- Direct replies, threads, and replies inside threads.
- Reactions.
- Typing snapshots and explicit start/clear command path.
- Media attachment metadata.
- Group mention/member-count metadata.
- Gateway JSON-lines send/event path.
- Leave room.
- Process-exit shutdown state reset.
- Encrypted-room decrypt after stopping and restarting the sidecar with the same SQLite crypto DB.
- Fresh-device E2EE health trust assertions when recovery keys are configured.

## Full Matrix smoke coverage

- Account A creates a private encrypted room and invites account B.
- Account B sees pending invite metadata and accepts explicitly. `inviter` is required;
  `displayName` is checked only when the homeserver includes room-name state in the invite.
- Account A sends encrypted text through `MatrixProvider`; account B receives normalized text.
- Account B replies with reply context; account A receives normalized text and `replyTo`.
- Account B sends a Matrix thread message; account A receives normalized text and `threadTo` without fallback `replyTo`.
- Account A replies inside that thread; account B receives normalized `replyTo` and `threadTo`.
- Account A reacts to Account B's message; account B receives normalized reaction context.
- Account A starts, then clears typing through the gateway JSON-lines command path; account B receives both snapshots.
- Account B typing is emitted as an inbound gateway snapshot for account A.
- Account A sends threaded text through the gateway command path.
- Account B sends text that is serialized through the gateway JSON-lines event path.
- Account A sends GFM text in an unencrypted room; Matrix receives its fallback body, a sanitized formatted body with a code-block table fallback, and no remote `<img>` elements.
- That room is upgraded to encryption; both directions still receive normalized text and raw
  Matrix events are encrypted.
- Accounts A, B, and C join an encrypted group room; Account A receives a normalized mention
  with `isGroupChat` and `wasMentioned` set.
- Account B leaves explicitly.
- Account B rejects a second invite without joining.
- Account B's process-exit shutdown path clears connection state.
- All accounts leave smoke-test rooms during cleanup.
- When recovery keys are configured, E2EE health must report recovery-key import, cross-signing identity, self-signed current device, and own-device trust.
- The test fails if any participant emits an unexpected transport error.

The test is skipped unless `UMG_MATRIX_SMOKE=1` is set, so normal `npm test` runs do not
contact Matrix.

## Observations

- 2026-06-18: `npm run test:matrix-smoke` timed out once waiting for the reject-room invite near the end of the test. Immediate retry passed. Repeat count: 1.

## Troubleshooting

A single invite wait timeout near the reject-invite phase may be Matrix sync timing. Retry once. If it recurs, record another observation and investigate invite sync state.
