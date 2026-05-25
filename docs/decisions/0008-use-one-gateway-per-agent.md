# Use one gateway per agent

## Context

The gateway owns transport connections, transport state, and the platform identity used by
an agent. An agent may need to participate in multiple conversations at once, including
multiple threads within the same transport, while still presenting one coherent identity.

A shared gateway serving multiple agents would need to route messages between agents,
isolate transport state by agent, and decide what happens when one agent or transport
fails. It would also make future agent-to-agent interaction riskier, because one shared
gateway could become a common failure point.

## Decision

Run one gateway per agent.

Each gateway owns one agent's transport identities, runtime state, and conversation fanout
across transports and threads. Agents are decoupled at the gateway boundary.

## Consequences

- One agent can span multiple transports and threads under one identity.
- Agent state and transport failures are isolated from other agents.
- Agents may later operate on or communicate with one another without sharing gateway
  process state.
- Multi-agent routing, shared transport pooling, and shared gateway lifecycle are out of
  scope unless a concrete need appears.
