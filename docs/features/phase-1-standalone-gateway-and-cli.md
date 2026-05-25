---
parent: "[[universal-messenger-gateway]]"
tags:
  - status/in-progress
---

# Phase 1 — Standalone gateway + cli

Stand up the gateway as a standalone service driven by a cli, with no bot attached.

## Scope

- Lift the transport layer in from the source extension (see [Contributing](../CONTRIBUTING.md)).
- Build the standard-I/O service shell around the transport manager: emit normalized
  inbound messages, accept "send message" / "send typing" commands.
- Build the cli: connect over the standard I/O, render inbound, send outbound — exercise a
  live transport with no bot.
- Re-home the admin surface (connect / disconnect / configure / status) as cli
  subcommands; drop the interactive menu and widget.

## Open decisions

None.

## Done when

The cli round-trips a real message on at least one transport — inbound rendered, outbound
delivered, encryption intact where the platform has it — with no bot involved.

Related: [0001](../decisions/0001-extract-transport-layer-as-a-standalone-gateway.md),
[0003](../decisions/0003-standard-io-is-the-product-cli-driven-development.md),
[0004](../decisions/0004-standard-gateway-envelope.md),
[0005](../decisions/0005-use-stdio-json-lines-for-gateway-io.md),
[0006](../decisions/0006-compile-first-party-transports-together.md),
[0007](../decisions/0007-use-repo-local-state-dir-for-phase-1.md),
[0008](../decisions/0008-use-one-gateway-per-agent.md).
