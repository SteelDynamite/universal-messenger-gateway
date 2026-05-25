# universal-messenger-gateway — Project State

Current active goal: stand up the standalone gateway + cli (Phase 1).

## Active work

- [Phase 1 — Standalone gateway + cli](features/phase-1-standalone-gateway-and-cli.md)

Project scaffold exists: `package.json`, `tsconfig`, `biome.json`, vitest config, and
`src/` are present. The first code surface is `src/protocol.ts`, which defines the
gateway event and command envelope for the documented Phase 1 message flow.

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
