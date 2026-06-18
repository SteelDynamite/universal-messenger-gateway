# Matrix smoke invite wait flake

## Problem

After removing `matrix-bot-sdk`, one live `npm run test:matrix-smoke` run timed out waiting for the reject-room invite near the end of the test. An immediate retry passed.

## Impact

A single transient invite/sync delay can make live smoke look failed even when the transport path is healthy.

## Current handling

Retry once when the only failure is a late invite wait and the focused mautrix smoke or a rerun passes.

## Retirement condition

If this recurs, add diagnostics around invite sync state and either increase the wait budget for invite-only assertions or make invite waiting observe raw `/sync` state before failing.

## Links

- [Matrix smoke tests](../runbooks/matrix-smoke-tests.md)
- [Intentional invite membership](../features/intentional-invite-membership.md)
