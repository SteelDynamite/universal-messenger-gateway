---
parent: "[[universal-messenger-gateway]]"
tags:
  - status/done
---

# Public Gateway SDK Factory

UMG already has a low-level typed client: `GatewayClient` / `ManagerGatewayClient`. This feature exposes a stable public factory and cleans up the API for embedding.

## Goal

Export `createGateway(options?: { stateDir?: string })` so pi-bot can embed UMG without constructing `TransportManager`, loading config, resolving default state, or spawning `umg gateway`.

## Current state

- `src/index.ts` exports `createGateway`, `CreateGatewayOptions`, `Gateway`, `GatewayClient`, `GatewayEventHandler`, and `ManagerGatewayClient`.
- `umg gateway` already uses the shared in-process client: stdin JSON-lines become `client.send(...)`; client events become stdout JSON-lines.
- `GatewayClient` exposes events, commands, admin operations, chat/invite listing, health, invite accept/reject, leave chat, connect/disconnect, and process-exit shutdown.
- The gateway command/event schema remains the source of truth per [ADR 0011](../decisions/0011-chat-is-a-wrapper-over-gateway-protocol.md).

## Public factory

`createGateway` is a convenience factory over `ManagerGatewayClient`:

```ts
const gateway: Gateway = await createGateway({ stateDir });

const unsubscribe = gateway.onEvent((event) => {});
await gateway.connect();
await gateway.send(command);
unsubscribe();
await gateway.disconnect();
```

`createGateway` hides:

- state-dir resolution
- config loading
- transport registry use
- `TransportManager` construction
- admin-command reload behavior

## API cleanup choices

Export a public return type alias:

```ts
export type Gateway = GatewayClient;
```

The public client returns idempotent unsubscribe functions for embedding cleanup:

```ts
const unsubscribe: () => void = gateway.onEvent(handler);
const unsubscribeErrors: () => void = gateway.onError(handler);
```

Keep lifecycle names aligned with the current API:

- `connect()`
- `disconnect()`
- `shutdownForProcessExit()`

A later wrapper may add `close()` as an alias, but it is not required for pi-bot.

Changing `onEvent` / `onError` from `void` to unsubscribe-returning is an interface change, but existing callers can ignore the returned function.

Do not replace the gateway protocol. The SDK is a later embedding mode over the same command/event contract.

## Admin reload behavior

For `configure_transport`, `connect_transport`, and `disconnect_transport`, the factory-provided client:

- execute the existing admin-command path against the same resolved `stateDir` used to construct the client
- reload config from that same `stateDir`
- replace transports
- reconnect enabled transports
- emit `admin_result` with success or failure output

This prevents custom `createGateway({ stateDir })` callers from writing config in one state dir while reloading another.

## CLI remains required

`umg chat` and `umg gateway` stay as first-class entrypoints for:

- isolated gateway smoke tests
- manual transport setup and diagnostics
- generic package use without pi-bot
- stdio JSON-lines integrations

## pi-bot use

pi-bot imports the factory directly:

```text
chat transport → UMG SDK → pi-bot → Pi SDK
chat transport ← UMG SDK ← pi-bot ← Pi SDK
```

This removes the need for pi-bot to spawn an `umg` subprocess for normal operation.

## Related

Updates [Phase 2 — Connect an agent](phase-2-connect-an-agent.md): pi-bot should prefer in-process SDK embedding over driving stdio, while stdio remains the generic gateway protocol and CLI smoke path.

## Done

- UMG exports stable `createGateway(options?: CreateGatewayOptions)` and `CreateGatewayOptions` from `src/index.ts`.
- `npm run build` generates `dist/index.d.ts` with `createGateway`.
- pi-bot imports the factory without touching `TransportManager`.
- `onEvent` and `onError` return unsubscribe functions.
- Lifecycle naming uses `connect()` / `disconnect()`.
- Factory tests prove default state-dir resolution, config load, manager creation, and admin reload path.
- Factory tests cover custom `stateDir` for `configure_transport`, `connect_transport`, and `disconnect_transport`.
- Existing gateway JSON-lines tests still pass.
- Existing Matrix smoke still passes through the CLI path.

## Verification

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `set -a && source state/matrix-smoke.env && set +a && UMG_MATRIX_SMOKE=1 npm run test:matrix-smoke`
- pi-bot SDK embedding verified with `npm run typecheck`, `npm test`, and `npm run build` in `../pi-bot`.
