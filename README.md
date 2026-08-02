# universal-messenger-gateway

A standalone, bot-agnostic gateway that speaks many chat platforms and exposes one
standardized I/O for a single bot.

## What it is

Connect one bot to many chat platforms without teaching the bot any platform's API. The
gateway owns the platform connections and the message envelope; the bot speaks one
standard I/O.

- **transport** — an adapter to one chat service (Matrix, Slack, Discord, Telegram,
  WhatsApp). Messages are *adapted* to and from the standard I/O, never mirrored between
  platforms.
- **gateway** — the portal a transport connects to on one side and a bot on the other.
  Owns the normalized envelope and all transport state (including the Matrix
  crypto/session store). Pure transport-layer — no bot logic.
- **cli** — drives the gateway over its standard I/O with no bot attached. Its help is
  designed for a minimal-context agent that was only told to use `umg` to communicate.

It is the transport layer of the
[pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) extension,
refactored into a standalone project.

## Status

Phase 1 is complete: the standalone gateway, cli, admin commands, interactive chat harness,
and live Matrix smoke coverage exist. No published release yet. See [`docs/`](docs/) for
scope and the next phase.

## Quick start

Configure Matrix interactively:

```bash
umg setup matrix
umg chat
```

`umg setup matrix` writes `state/config.json` and local secret files such as
`state/matrix-access-token.txt` with `600` permissions. Matrix E2EE state is stored
in `state/mautrix-crypto.db`; bounded media downloads are stored under `state/media/`.
Outbound Matrix attachments stream from disk, preserve image/file/audio/video kind, support same-event captions with the original filename, and reject files over 1 GiB.
Matrix chat type follows `m.direct`; unnamed two-member rooms remain a compatibility fallback, while named rooms and channels are group chats.
State defaults to `./state`; override it with
`UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR=/path`.

## Embedded agent operations

The SDK exports `AGENT_OPERATION_DESCRIPTORS` and `GatewayClient.executeAgentOperation()`. The descriptor registry generates bounded operation schemas and help for chats, members, source-of-truth messages, relations, media, pins, invites, non-admin writes, and diagnostics. Direct current-chat lookup returns normalized display name, type, topic, and avatar URL when available; Matrix pin lookup resolves source messages and unavailable statuses. Admin transport configuration is excluded.

## Documentation

This repo is an Obsidian vault rooted at the repo root; docs live in [`docs/`](docs/).

- [Contributing](docs/CONTRIBUTING.md) — developer mental model and structure
- [Glossary](docs/GLOSSARY.md) — project vocabulary
- [Conventions](docs/CONVENTIONS.md) — code and docs rules
- [Decisions](docs/decisions/) · [Runbooks](docs/runbooks/) · [Features](docs/features/)

## License

MIT — see [LICENSE](LICENSE). Derived in part from
[pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) (MIT); upstream
attribution is preserved on the transport-layer code as it is imported.
