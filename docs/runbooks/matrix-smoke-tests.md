# Matrix Smoke Tests

Run live Matrix round-trips between three controlled test accounts.

## Requirements

- Three Matrix accounts on a homeserver that allows private encrypted rooms.
- Access tokens for all accounts.
- Optional account passwords and recovery keys if cross-signing setup needs them.
- A gitignored state directory; defaults to `state/matrix-smoke/`.

The runner stores each account under a state subdirectory derived from its Matrix user ID. This
prevents stale crypto stores from one account being reused with another account's access token.

## Command

Use the gitignored local env file when it exists:

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
  `UMG_MATRIX_C_RECOVERY_KEY`.

Quote values that contain spaces, especially Matrix recovery keys:

```sh
UMG_MATRIX_A_RECOVERY_KEY='word1 word2 word3 ...'
```

## Current Coverage

- Account A creates a private encrypted room and invites account B.
- Account B sees pending invite metadata and accepts explicitly. `inviter` is required;
  `displayName` is checked only when the homeserver includes room-name state in the invite.
- Account A sends encrypted text through `MatrixProvider`; account B receives normalized text.
- Account B replies with reply context; account A receives normalized text and `replyTo`.
- Account B sends a Matrix thread message; account A receives normalized text and `threadTo` without fallback `replyTo`.
- Account A replies inside that thread; account B receives normalized `replyTo` and `threadTo`.
- Account A reacts to Account B's message; account B receives normalized reaction context.
- Account A sends typing and text through the gateway JSON-lines command path.
- Account A sends threaded text through the gateway command path.
- Account B sends text that is serialized through the gateway JSON-lines event path.
- Account A sends formatted text in an unencrypted room; Matrix receives the formatted body.
- Accounts A, B, and C join an encrypted group room; Account A receives a normalized mention
  with `isGroupChat` and `wasMentioned` set.
- Account B leaves explicitly.
- Account B rejects a second invite without joining.
- Account B's process-exit shutdown path clears connection state.
- All accounts leave smoke-test rooms during cleanup.
- The test fails if any participant emits an unexpected transport error.

The test is skipped unless `UMG_MATRIX_SMOKE=1` is set, so normal `npm test` runs do not
contact Matrix.
