# Chat is a wrapper over the gateway protocol

## Context

The public cli surface is `umg chat` and `umg gateway`. Both must expose the same
capabilities. Duplicating transport control in chat and gateway risks drift.

## Decision

Make `umg gateway` the runtime/control engine and make `umg chat` a human-friendly client
for that same protocol.

`umg chat` should translate slash commands and typed messages into gateway JSON-lines
commands, then render gateway events for a human. It should not call the transport manager
or config layer directly except through a shared in-process gateway client abstraction.

## Consequences

- Gateway command/event schema is the source of truth.
- Chat cannot gain capabilities that gateway lacks.
- Future tests should verify chat behavior through gateway commands/events, not duplicate
  transport-manager paths.
- The first implementation may be in-process. A child-process gateway can be considered
  later if process isolation matters.
