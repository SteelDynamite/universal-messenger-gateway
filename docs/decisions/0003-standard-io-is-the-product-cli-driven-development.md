# The standard I/O is the product; develop cli-first

## Context

The gateway needs a consumer to be useful. Building it against a real bot first would
couple the gateway's development to that bot and make isolated testing hard.

## Decision

Treat the gateway's standard I/O envelope as the primary deliverable. Develop against a
**cli** that drives that I/O with no bot attached. A production orchestrator implements the
same consumer side later and swaps in where the cli sat.

## Consequences

- The gateway is exercisable end-to-end against real platforms before any bot exists.
- Whatever I/O mechanism the cli uses, the orchestrator inherits — so the choice is
  load-bearing (tracked as an open decision).
