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

The standard I/O is newline-delimited JSON over stdin/stdout for Phase 1. Daemon/socket
behavior is deferred until a concrete process-lifetime problem exists.

Phase 1 runtime state defaults to `./state` and can be overridden with
`UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR`. The intended shape is one gateway per agent.

The standard I/O contract is the actual product — pin it before adding features. See the
[glossary](GLOSSARY.md) for terms.

## Origin

This is the transport layer of the
[pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) extension, lifted
into a standalone, bot-agnostic project. That transport layer was already free of bot
coupling; the refactor formalizes the seam.

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
- `src/cli.ts` — cli entrypoint; currently a placeholder until the I/O mechanism is set.
- `src/transports/` — expected home for compiled first-party adapters as they are lifted.

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
