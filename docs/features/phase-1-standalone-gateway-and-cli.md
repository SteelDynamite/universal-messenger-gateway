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
- Build the cli for a minimal-context agent: bare `umg` onboards the agent, lists commands
  and transport status, and points to the shortest path from empty state to messaging.
- Add an [interactive dev chat cli](interactive-dev-chat-cli.md) for manual live transport
  testing without hand-written JSON-lines.
- Re-home the admin surface (connect / disconnect / configure / status) as cli
  subcommands; drop the interactive menu and widget.

## Cli entrypoint

Bare `umg` is help-like, exits successfully, and assumes the reader is an agent that only
knows it should use this cli to communicate. It points to `chat` and `gateway` as the two
public operating modes and lists all known transports with support status.

`umg chat` and `umg gateway` expose the same transport control surface. When no transports
are enabled, chat starts in configuration mode instead of claiming to be connected. Chat
accepts `/configure`, `/connect`, and `/disconnect` with the same syntax as the top-level
admin commands and reloads transports live after successful changes. Gateway accepts the
same operations as JSON-lines admin commands, emits `admin_result` events, and
emits `command_error` events when outbound commands fail.

## Admin surface

There are no top-level admin commands. Configuration and transport control happen inside
an attached session:

- `umg chat` accepts `/status`, `/configure`, `/connect`, and `/disconnect`.
- `umg gateway` accepts equivalent JSON-lines admin commands and emits `admin_result`
  events.

The shared admin operations print the state directory, list known transports, update
`state/config.json`, and reload transports live after successful changes.

Longer-term chat-client behavior is tracked separately in the
[client capability backlog](client-capability-backlog.md).

## Runtime control

Daemon/socket behavior remains deferred. Stdio JSON-lines is enough until a concrete
process-lifetime problem appears.

## Result

The cli round-trips real encrypted Matrix messages with no bot involved. The live Matrix
smoke test covers the gateway JSON-lines command/event path and the admin cli flow.
Gateway mode disconnects transports on stdin EOF.

Related: 
[0001](../decisions/0001-extract-transport-layer-as-a-standalone-gateway.md),
[0003](../decisions/0003-standard-io-is-the-product-cli-driven-development.md),
[0004](../decisions/0004-standard-gateway-envelope.md),
[0005](../decisions/0005-use-stdio-json-lines-for-gateway-io.md),
[0006](../decisions/0006-compile-first-party-transports-together.md),
[0007](../decisions/0007-use-repo-local-state-dir-for-phase-1.md),
[0008](../decisions/0008-use-one-gateway-per-agent.md),
[0009](../decisions/0009-use-matrix-bot-sdk-for-first-matrix-transport.md),
[0010](../decisions/0010-design-cli-for-minimal-context-agents.md),
[0011](../decisions/0011-chat-is-a-wrapper-over-gateway-protocol.md).
