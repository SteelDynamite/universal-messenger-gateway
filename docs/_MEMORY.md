# universal-messenger-gateway — Project State

Current active goal: stand up the standalone gateway + cli (Phase 1).

## Active work

- [Phase 1 — Standalone gateway + cli](features/phase-1-standalone-gateway-and-cli.md)

Project scaffold exists: `package.json`, `tsconfig`, `biome.json`, vitest config, and
`src/` are present. The first code surfaces are `src/protocol.ts`, the JSON-lines stdio
shell, `state/config.json` loading, and the minimal transport interface/manager seam.
Matrix is the first real transport target. `matrix-utils.ts` is lifted first because it is
pure and carries useful tests before SDK/crypto dependencies land.
Matrix SDK integration is underway: storage belongs under `./state`, and authorization is
not embedded in the transport.
`matrix-bot-sdk` has inherited npm audit findings through `request`; see ADR 0009.
`umg chat` now exists as a small readline-style harness for live Matrix testing.
The gated [automated Matrix smoke test](features/automated-matrix-smoke-tests.md)
round-trips encrypted messages between two live accounts and covers explicit invite
accept/reject. [Intentional invite membership](features/intentional-invite-membership.md)
is complete: Matrix no longer autojoins, pending invites surface in `umg chat`, and Matrix
joins only after explicit accept. The smoke runner now also covers reply context, reactions,
leave behavior, and process-exit shutdown; the gated live Matrix smoke test passed with local
credentials. The Phase 1 admin cli now has config-oriented `status`, `configure`, `connect`,
and `disconnect` commands, and the live Matrix smoke test covers that admin flow against real
credentials. Next action: decide whether Phase 1 needs daemon-style runtime control before
closing the phase.
Interactive chat mode uses a hard process exit on quit; see
[tech-debt 0001](techdebt/0001-bun-matrix-crypto-hard-exit.md).
Rich client behavior is tracked in [client capability backlog](features/client-capability-backlog.md)
and [rich message capabilities](features/rich-message-capabilities.md).

Local Matrix smoke-test state exists under gitignored `state/`: `config.json`,
`matrix-recovery-key.txt`, `matrix-password.txt`, `matrix-store.json`, and
`matrix-crypto/`. Do not commit `state/`. The Matrix recovery key file is read from
`state/matrix-recovery-key.txt` by default and must stay `0600`.

## Source to lift from

Lift the transport layer from the **`SteelDynamite/pi-messenger-bridge`** fork, **not**
upstream `tintinweb/pi-messenger-bridge`. The fork carries the Matrix cross-signing patches
(`matrix-crosssign.ts`) that make E2EE actually work; upstream lacks them. Take that file
as-is.

The seam in the source is already clean (the transport layer has no bot coupling):

- `src/transports/` (manager, interface, the five adapters, matrix-crosssign, matrix-utils),
  `src/auth/`, `src/config.ts`, `src/lock.ts`, `src/types.ts` — move nearly verbatim.
- All bot coupling sits in `src/index.ts`: four lifecycle handlers (inbound message → bot,
  bot-busy → typing indicator, bot reply → outbound, shutdown) plus the `registerCommand`
  admin surface. None of that comes over as-is — it's the cli/orchestrator's job.
- `src/formatting.ts` splits: `splitMessage` (platform char-limit chunking) is a gateway
  concern; the functions that parse a bot's reply shape are the orchestrator's.
- `src/ui/` (interactive menu, status widget) is dropped; admin becomes cli subcommands.

The contract surfaces to start from: `ITransportProvider` =
`type, isConnected, connect, disconnect, sendMessage(chatId, text), sendTyping(chatId),
onMessage(handler), onError(handler)`. `TransportManager` fans these in and out and is the
core the gateway wraps.

## Open decisions

No Phase 1 gate decisions are currently open.

## Lifecycle

When a decision lands, migrate it from here into an ADR in `decisions/` and clear it from
this list. This file is active state only — durable knowledge belongs in the stable docs.
