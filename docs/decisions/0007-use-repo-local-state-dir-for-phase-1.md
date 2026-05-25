# Use a repo-local state dir for Phase 1

## Context

The gateway owns transport config and runtime state, including Matrix crypto/session data.
Phase 1 is local development and transport validation, not installation or multi-agent
deployment.

The intended deployment shape is one gateway per agent. See
[0008](0008-use-one-gateway-per-agent.md).

## Decision

Use `./state` as the default state directory for Phase 1. Allow
`UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR` to override it.

## Consequences

- Local development state is easy to inspect, reset, and keep out of git.
- Tests and examples can use explicit temporary state directories.
- The default depends on the current working directory.
- OS app-data defaults can be reconsidered when installation or distribution matters.
