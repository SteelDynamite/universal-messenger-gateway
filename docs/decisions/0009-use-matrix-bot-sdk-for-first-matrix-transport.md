# Use matrix-bot-sdk for the first Matrix transport

## Context

The source fork's Matrix transport is built on `matrix-bot-sdk` and carries working E2EE
and cross-signing patches against that stack. Replacing the SDK while lifting the transport
would mix a transport extraction with a Matrix client rewrite.

`matrix-bot-sdk` currently pulls deprecated `request` dependencies that produce npm audit
findings with no available transitive fix. Current production audit findings are inherited
through `matrix-bot-sdk` / `request` (`form-data`, `qs`, `request`, `request-promise`,
`request-promise-core`, `tough-cookie`, and `uuid`).

## Decision

Use `matrix-bot-sdk` for the first Matrix transport and pin
`@matrix-org/matrix-sdk-crypto-nodejs` to `0.6.0` through npm overrides, matching the fork's
cross-signing requirement.

## Consequences

- Matrix can be lifted with the known-working E2EE/cross-signing behavior from the fork.
- The first live transport validates the gateway seam before any Matrix SDK rewrite.
- npm audit reports inherited `request`-family vulnerabilities with no direct fix.
- Do not run `npm audit fix --force`; it cannot remove this chain without a Matrix SDK change.
- Revisit the Matrix client stack after live encrypted Matrix support is stable enough to replace the SDK deliberately.
