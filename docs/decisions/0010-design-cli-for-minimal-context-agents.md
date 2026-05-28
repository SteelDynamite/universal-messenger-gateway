# Design the cli for minimal-context agents

## Context

The main cli consumer may be an agent that was told only to use `umg` to communicate over
available transports. It may not have read this repository's docs, know the transport
lifecycle, or understand which commands are human-facing versus machine-facing.

## Decision

Treat bare `umg` and help output as agent onboarding. The cli should expose the smallest
useful path from no context to messaging:

1. choose `umg chat` for interactive use or `umg gateway` for JSON-lines integration,
2. inspect state from inside that session,
3. configure, enable, and use transports without leaving the session.

Help text should name every known transport and show its support status. It should avoid
assuming a human operator has project context.

## Consequences

- Bare `umg` is help-like and exits successfully.
- The public cli surface is `chat` and `gateway`; admin operations are session commands.
- Command descriptions favor what an agent should do next over internal implementation
  details.
- Transport status labels become part of the discovery surface and should stay current
  when transports are added or stabilized.
