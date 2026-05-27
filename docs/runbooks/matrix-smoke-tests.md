# Matrix Smoke Tests

Run a live encrypted Matrix round-trip between two controlled test accounts.

## Requirements

- Two Matrix accounts on a homeserver that allows private encrypted rooms.
- Access tokens for both accounts.
- Optional account passwords and recovery keys if cross-signing setup needs them.
- A gitignored state directory; defaults to `state/matrix-smoke/`.

## Command

Use the gitignored local env file when it exists:

```sh
set -a && source state/matrix-smoke.env && set +a && UMG_MATRIX_SMOKE=1 bun run test:matrix-smoke
```

Or export the variables directly:

```sh
UMG_MATRIX_SMOKE=1 \
UMG_MATRIX_HOMESERVER_URL=https://matrix.example \
UMG_MATRIX_A_ACCESS_TOKEN=... \
UMG_MATRIX_B_ACCESS_TOKEN=... \
bun run test:matrix-smoke
```

Optional variables:

- `UMG_MATRIX_SMOKE_STATE_DIR` — defaults to `state/matrix-smoke`.
- `UMG_MATRIX_A_ACCOUNT_PASSWORD` and `UMG_MATRIX_B_ACCOUNT_PASSWORD`.
- `UMG_MATRIX_A_RECOVERY_KEY` and `UMG_MATRIX_B_RECOVERY_KEY`.

Quote values that contain spaces, especially Matrix recovery keys:

```sh
UMG_MATRIX_A_RECOVERY_KEY='word1 word2 word3 ...'
```

## Current Coverage

- Account A creates a private encrypted room and invites account B.
- Account B sees the pending invite and accepts explicitly.
- Account A sends encrypted text through `MatrixProvider`; account B receives normalized text.
- Account B replies with reply context; account A receives normalized text and `replyTo`.
- Account A reacts to Account B's message; account B receives normalized reaction context.
- Account B leaves explicitly.
- Account B rejects a second invite without joining.
- Account B's process-exit shutdown path clears connection state.
- Both accounts leave smoke-test rooms during cleanup.

The test is skipped unless `UMG_MATRIX_SMOKE=1` is set, so normal `npm test` runs do not
contact Matrix.
