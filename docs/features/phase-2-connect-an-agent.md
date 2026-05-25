---
parent: "[[universal-messenger-gateway]]"
tags:
  - status/backlog
---

# Phase 2 — Connect an agent

Build the orchestrator that drives the gateway's standard I/O on a bot's behalf, replacing
the cli.

## Scope

- A consumer process that connects a bot to the gateway and routes between them.
- Inbound message → bot; bot reply → outbound; typing indicators; correlation of a reply
  back to the originating chat.

Bot-specific wiring — how a particular agent is invoked — lives with that agent, not in
this repo.

## Done when

A bot exchanges messages with a real chat platform through the gateway + orchestrator.

Related: [0001](../decisions/0001-extract-transport-layer-as-a-standalone-gateway.md).
