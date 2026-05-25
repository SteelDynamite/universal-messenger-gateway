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

Run the gateway:

```bash
npm run build
node dist/cli.js gateway
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

The gateway emits inbound messages as JSON-lines on stdout and reads `send_message` /
`send_typing` commands as JSON-lines on stdin.
