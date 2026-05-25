# universal-messenger-gateway — Project State

Current active goal: stand up the standalone gateway + cli (Phase 1).

## Active work

- [Phase 1 — Standalone gateway + cli](features/phase-1-standalone-gateway-and-cli.md)

No code or scaffold exists yet — `package.json`, `tsconfig`, `biome.json`, vitest config,
and `src/` are all still to create. The docs describe the target; nothing is built.

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

## Open decisions — reasoning captured, not yet decided

These gate Phase 1. **D1 and D2 are the maintainer's call — do not auto-decide them.**

**D1 — the standard envelope (decide first; everything hangs off it).**
Inbound already exists as the fork's `ExternalMessage`: `chatId, transport, content,
username, userId, timestamp, messageId, isGroupChat, wasMentioned`. It only lacks a
**reply-to reference** — add one when reply-context is built. Outbound is the new half:
minimally `{ transport, chatId, text }`, a typing command `{ transport, chatId }`, and
reply/edit refs later. Pin the exact shape of both directions before writing the service.

**D2 — cli↔gateway I/O mechanism.**
- *stdio JSON-lines* — simplest; the cli spawns the gateway as a child process.
- *unix socket* — lets the gateway stay long-lived while the cli connects and disconnects.
  This matters because the gateway holds the **Matrix crypto/session**: with stdio you
  re-handshake Matrix on every cli run; with a socket you don't.

Leaning unix socket for that reason — but it's a genuine call. Whatever is chosen, the
orchestrator inherits it (same consumer seam — see [ADR 0003](decisions/0003-standard-io-is-the-product-cli-driven-development.md)).

**D3 — transport load model.** Compiled-in adapters, enabled by config, for now;
plugin-dir dynamic loading only if it earns its keep. Low stakes — safe to do the config
version.

**D4 — state dir.** Gateway owns its own state path (transport config + Matrix crypto
store). Pick an env var (e.g. `UMG_STATE_DIR`) and a default. Low stakes.

## Lifecycle

When a decision lands, migrate it from here into an ADR in `decisions/` and clear it from
this list. This file is active state only — durable knowledge belongs in the stable docs.
