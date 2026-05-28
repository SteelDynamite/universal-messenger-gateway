# Matrix Local Smoke Test

Create `state/config.json`:

```json
{
  "transports": {
    "matrix": {
      "enabled": true,
      "settings": {
        "homeserverUrl": "https://matrix.example.org",
        "accessToken": "YOUR_ACCESS_TOKEN",
        "encryption": true
      }
    }
  }
}
```

Run the interactive chat harness:

```bash
npm run build
node dist/cli.js chat
```

Matrix state is written under `./state` by default:

- `state/matrix-store.json` — Matrix SDK sync/storage state.
- `state/matrix-crypto/` — Rust crypto store when E2EE is enabled.

For cross-signing, prefer a recovery key from an existing Element secure backup:

```bash
printf '%s' 'YOUR_RECOVERY_KEY' > state/matrix-recovery-key.txt
chmod 600 state/matrix-recovery-key.txt
node dist/cli.js gateway
```

When a recovery key is available, startup imports the existing cross-signing identity from
Secret Storage even if the Matrix device is already signed. A signed device alone does not
prove the local crypto store has imported the private cross-signing secrets.

If a password is needed for a reset flow, store it the same way:

```bash
printf '%s' 'YOUR_ACCOUNT_PASSWORD' > state/matrix-password.txt
chmod 600 state/matrix-password.txt
```

Environment variables override local files:

- `UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY`
- `UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY_FILE`
- `UNIVERSAL_MESSENGER_GATEWAY_MATRIX_ACCOUNT_PASSWORD`
- `UNIVERSAL_MESSENGER_GATEWAY_MATRIX_PASSWORD_FILE`

For an encrypted DM invite smoke test:

1. Invite the Matrix account used by the gateway to a DM.
2. If the first inbound message cannot decrypt, `umg chat` selects that Matrix room and
   prints a diagnostic.
3. Type one message from `umg chat` to bootstrap room-key sharing.
4. Reply from the other Matrix client; the reply should print in `umg chat`.
5. Use `/leave` to leave the current room before rerunning the invite flow.

The raw gateway mode still exists for JSON-lines testing:

```bash
npm run build
node dist/cli.js gateway
```

It emits inbound messages as JSON-lines on stdout and reads `send_message` / `send_typing`
commands as JSON-lines on stdin.
