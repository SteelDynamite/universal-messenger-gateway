---
parent: "[[universal-messenger-gateway]]"
tags:
  - status/complete
---

# Phase 1 — Standalone gateway + cli

The standalone gateway and cli are complete for Phase 1, with no bot attached.

## Scope

- Lift the transport layer in from the source extension (see [Contributing](../CONTRIBUTING.md)).
- Build the standard-I/O service shell around the transport manager: emit normalized
  inbound messages, accept "send message" / "send typing" commands.
- Build the cli: connect over the standard I/O, render inbound, send outbound — exercise a
  live transport with no bot.
- Add an [interactive dev chat cli](interactive-dev-chat-cli.md) for manual live transport
  testing without hand-written JSON-lines.
- Re-home the admin surface (connect / disconnect / configure / status) as cli
  subcommands; drop the interactive menu and widget.

## Admin cli

The Phase 1 admin surface is config-oriented because there is no long-running daemon to
control yet:

- `umg status` prints the state directory, each known transport, whether it is enabled, and
  configured setting names without printing secret values.
- `umg configure <transport> [--enable|--disable] [--set key=value]...` updates
  `state/config.json`.
- `umg connect <transport>` enables the transport for future `umg gateway` or `umg chat`
  runs.
- `umg disconnect <transport>` disables the transport for future runs.

Longer-term chat-client behavior is tracked separately in the
[client capability backlog](client-capability-backlog.md).

## Runtime control

Daemon/socket behavior remains deferred. Stdio JSON-lines is enough until a concrete
process-lifetime problem appears.

## Result

The cli round-trips real encrypted Matrix messages with no bot involved. The live Matrix
smoke test covers the gateway JSON-lines command/event path and the admin cli flow.

Related: 
[0001](../decisions/0001-extract-transport-layer-as-a-standalone-gateway.md),
[0003](../decisions/0003-standard-io-is-the-product-cli-driven-development.md),
[0004](../decisions/0004-standard-gateway-envelope.md),
[0005](../decisions/0005-use-stdio-json-lines-for-gateway-io.md),
[0006](../decisions/0006-compile-first-party-transports-together.md),
[0007](../decisions/0007-use-repo-local-state-dir-for-phase-1.md),
[0008](../decisions/0008-use-one-gateway-per-agent.md),
[0009](../decisions/0009-use-matrix-bot-sdk-for-first-matrix-transport.md).
