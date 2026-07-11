# Matrix Local Smoke Test

Interactive setup:

```bash
umg setup matrix
```

This writes `state/config.json` plus local secret files with `600` permissions.

Manual setup: create `state/config.json`:

```json
{
  "transports": {
    "matrix": {
      "enabled": true,
      "settings": {
        "homeserverUrl": "https://matrix.example.org",
        "encryption": true
      }
    }
  }
}
```

Store the access token in a local file:

```bash
printf '%s' 'YOUR_ACCESS_TOKEN' > state/matrix-access-token.txt
chmod 600 state/matrix-access-token.txt
```

Run the interactive chat harness:

```bash
npm run build
node dist/cli.js chat
```

On connect, `umg chat` starts the Python `mautrix` sidecar. `/status` prints the current
`matrix-e2ee` check with details. `ready` means the sidecar and SQLite crypto store are available.

Matrix state is written under `./state` by default:

- `state/mautrix-crypto.db` — Python `mautrix` SQLite crypto/state store.

If a password is needed for a reset flow, store it the same way:

```bash
printf '%s' 'YOUR_ACCOUNT_PASSWORD' > state/matrix-password.txt
chmod 600 state/matrix-password.txt
```

Local development needs Python dependencies installed. Use a venv and point UMG at it:

```bash
python3 -m venv /tmp/umg-mautrix-venv
/tmp/umg-mautrix-venv/bin/pip install -r requirements-mautrix.txt
export UMG_MATRIX_MAUTRIX_PYTHON=/tmp/umg-mautrix-venv/bin/python
```

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

It emits inbound events as JSON-lines on stdout and reads `send_message` / `set_typing`
commands as JSON-lines on stdin.
