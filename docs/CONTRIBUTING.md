# Contributing to universal-messenger-gateway

Read the [README](../README.md) first for what the project is and what it exposes.

## Mental model

One bot, many chat platforms. The gateway owns the platform connections and a normalized
message envelope; a bot speaks a single standard I/O and never touches a platform API.

The whole system is `cli > gateway > transport`:

- a **transport** adapts one platform to the gateway's internal interface,
- the **gateway** normalizes and multiplexes,
- a consumer (the **cli** in development, an **orchestrator** in production) drives the
  standard I/O.

The standard I/O is newline-delimited JSON over stdin/stdout. Daemon/socket behavior is
deferred until a concrete process-lifetime problem exists.

Runtime state defaults to `./state` and can be overridden with
`UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR`. The intended shape is one gateway per agent.
Transport config loads from `state/config.json`; `umg setup matrix` creates it
interactively. Matrix access tokens live in `state/matrix-access-token.txt` with `600` permissions.
The default Matrix adapter is the Python `mautrix` sidecar; it stores SQLite crypto state in
`state/mautrix-crypto.db`.

The standard I/O contract is the actual product — pin it before adding features. See the
[glossary](GLOSSARY.md) for terms.

## Origin

This is the transport layer of the
[pi-messenger-bridge](https://github.com/SteelDynamite/pi-messenger-bridge) fork, lifted
into a standalone, bot-agnostic project. Use that fork, not upstream, when lifting more
transport code; it carries the Matrix cross-signing patches. That transport layer was
already free of bot coupling; the refactor formalizes the seam.

What carries over from the extension:

- **as-is:** the transport manager, the transport interface, the per-platform adapters
  (Matrix incl. cross-signing, Slack, Discord, Telegram, WhatsApp), challenge-auth,
  config, the single-instance lock, and the inbound message envelope.
- **splits:** message formatting — platform chunking is a gateway concern; anything that
  parses a bot's reply shape belongs to the orchestrator.
- **dropped:** the extension's interactive menu and status widget; the admin surface
  becomes cli subcommands.

## Project structure

- `src/protocol.ts` — standard gateway event and command envelope.
- `src/agent-operations.ts` — generated-help, bounded non-admin agent operation registry.
- `src/config.ts` — `state/config.json` loading and validation.
- `src/cli.ts` — cli entrypoint for `gateway`, `chat`, and `setup`.
- `src/setup.ts` — interactive setup for transport config and local secret files.
- `src/transports/` — transport interface, manager, registry, Matrix adapter, and Matrix
  E2EE helpers. Other first-party adapters remain to be lifted.

## Where to look next

- [Conventions](CONVENTIONS.md)
- [Glossary](GLOSSARY.md)
- Decisions: [`decisions/`](decisions/)
- Runbooks: [`runbooks/`](runbooks/)
- Features / roadmap: [`features/`](features/)

## Adding docs

- A choice with rationale → a new ADR in `decisions/` (`NNNN-subject.md`).
- A repeatable procedure → `runbooks/`.
- A feature, phase, or task → a flat note in `features/`.
- Active in-flight state → [`_MEMORY.md`](_MEMORY.md), migrated to a durable doc when done.
