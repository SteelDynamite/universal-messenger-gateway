---
parent: "[[universal-messenger-gateway]]"
tags:
  - status/backlog
---

# Phase 2 — Connect an agent

Build the orchestrator that connects a bot to the gateway, replacing the cli for production use.

Prefer in-process SDK embedding via [Public Gateway SDK Factory](gateway-sdk.md). Standard I/O remains the generic gateway protocol and CLI smoke-test path.

## Scope

- A consumer process that connects a bot to the gateway and routes between them.
- Inbound message → bot; bot reply → outbound; typing indicators; correlation of a reply
  back to the originating chat.

Bot-specific wiring — how a particular agent is invoked — lives with that agent, not in
this repo.

## Done when

A bot exchanges messages with a real chat platform through the gateway + orchestrator.

Related: [0001](../decisions/0001-extract-transport-layer-as-a-standalone-gateway.md).
