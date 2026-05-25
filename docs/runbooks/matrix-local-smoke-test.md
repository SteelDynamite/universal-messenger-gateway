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
UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY='...' node dist/cli.js gateway
```

The gateway emits inbound messages as JSON-lines on stdout and reads `send_message` /
`send_typing` commands as JSON-lines on stdin.
