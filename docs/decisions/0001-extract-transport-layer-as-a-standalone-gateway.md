# Extract the transport layer as a standalone gateway

## Context

The transport layer began life inside a chat extension that coupled platform I/O, bot
wiring, and routing in one process. The platform code was already bot-agnostic, but it
shipped welded to one bot.

## Decision

Lift the transport layer out into a standalone, bot-agnostic gateway. Split the system on
the transport-vs-logic seam: the gateway owns the platforms and the message envelope; a
separate consumer (the cli in development, an orchestrator in production) owns bot wiring
and routing.

## Consequences

- The gateway can be built and tested with no bot attached.
- The consumer becomes the integration point for any bot and for later additions.
- A standard I/O contract between gateway and consumer must be defined and versioned — that
  contract is the project's core deliverable.
