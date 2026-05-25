# Use matrix-bot-sdk for the first Matrix transport

## Context

The source fork's Matrix transport is built on `matrix-bot-sdk` and carries working E2EE
and cross-signing patches against that stack. Replacing the SDK while lifting the transport
would mix a transport extraction with a Matrix client rewrite.

`matrix-bot-sdk` currently pulls deprecated `request` dependencies that produce npm audit
findings with no available transitive fix.

## Decision

Use `matrix-bot-sdk` for the first Matrix transport and pin
`@matrix-org/matrix-sdk-crypto-nodejs` to `0.6.0` through npm overrides, matching the fork's
cross-signing requirement.

## Consequences

- Matrix can be lifted with the known-working E2EE/cross-signing behavior from the fork.
- The first live transport validates the gateway seam before any Matrix SDK rewrite.
- npm audit reports inherited `request`-family vulnerabilities with no direct fix.
- Revisit the Matrix client stack after Phase 1 proves live encrypted round-trips.
