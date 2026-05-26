---
parent: "[[phase-1-standalone-gateway-and-cli]]"
tags:
  - status/planned
---

# Automated Matrix Smoke Tests

Automate live Matrix smoke testing with two controlled Matrix accounts talking through the
homeserver.

## Purpose

Manual `umg chat` testing has already exposed real issues around E2EE room-key sharing,
target selection, invite handling, display names, prompt redraws, and shutdown. A scripted
two-account smoke test should catch these regressions before they reach manual testing.

## Shape

- Use two Matrix accounts with separate state directories and access tokens.
- Start two gateway instances or one test harness with two Matrix transports.
- Create or reuse a test room/DM.
- Exercise invite, accept/reject, send, receive, reply context, reactions, leave, and shutdown.
- Assert both protocol events and visible chat-harness behavior where practical.
- Keep credentials and crypto state under gitignored `state/` or an explicit test state dir.

## First Scenario

1. Account A invites account B.
2. Account B sees a pending invite and accepts intentionally.
3. Account A sends an encrypted message.
4. Account B receives normalized inbound text.
5. Account B replies.
6. Account A receives normalized inbound text.
7. Account A reacts to B's message.
8. Account B receives reaction context.
9. Account B leaves with a reason.

## Open Design Points

- How to provision the second account/token safely.
- How much Matrix state to reuse versus recreate per run.

## Current Runner

The smoke test lives in `tests/matrix-smoke.test.ts` and runs through Vitest with
`bun run test:matrix-smoke`. It is skipped unless `UMG_MATRIX_SMOKE=1` is set. It covers
explicit invite accept/reject and encrypted A-to-B/B-to-A round trips. See [Matrix smoke
tests](../runbooks/matrix-smoke-tests.md) for required environment variables.

## Done When

- A maintainer can run one command and verify encrypted Matrix round-trip behavior between
  two accounts.
- The test fails clearly on missing room keys, invite handling regressions, missing reply
  context, missing reactions, or shutdown failures.
