# Matrix smoke room-key sharing failure

## Problem

Live Matrix smoke currently fails before the first encrypted round-trip. Account A sends the
first encrypted message after account B accepts the invite, but account B cannot decrypt it:

```text
MatrixDecryptionError: Matrix event could not be decrypted
Caused by: Can't find the room key to decrypt the event, withheld code: None
```

The failure reproduces on Linux with the local smoke accounts and is not related to chat input
editing.

## What was checked

- The timeout was converted locally into an explicit decryption failure by surfacing unexpected
  participant errors from `waitForMessage`.
- Deleting the local smoke `matrix-crypto` directories did not fix the failure.
- Calling the SDK crypto room-join/member refresh path before send did not fix the failure.
- Temporarily forcing the SDK's Rust key-share strategy to `CollectStrategy.AllDevices` in
  `node_modules` did not fix the failure.

## Likely area

The sender is encrypting before the recipient can receive or process the Megolm room key for the
new room. This may be due to smoke account/device trust state, `matrix-bot-sdk` room-key sharing
behavior, or the test setup creating/joining/sending too quickly for the SDK crypto state.

## Next steps

1. Add safe diagnostics around outgoing `m.room_key` / `m.room_key.withheld` to-device requests.
2. Inspect whether account A sends a room key to account B's current device for the failed room.
3. Inspect whether account B receives/decrypts the to-device room-key event before the encrypted
   room event.
4. Decide whether the smoke harness should explicitly wait for key-share readiness or establish
   device trust before the first encrypted send.
5. Re-test against upgraded `matrix-bot-sdk` / `@matrix-org/matrix-sdk-crypto-nodejs` versions.
