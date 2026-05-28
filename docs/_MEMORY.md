# universal-messenger-gateway — Project State

Current active goal: ready to start [Phase 2 — Connect an agent](features/phase-2-connect-an-agent.md).

## Active work

None. Do not start Phase 2 until explicitly asked.

## Phase 1 closeout

[Phase 1 — Standalone gateway + cli](features/phase-1-standalone-gateway-and-cli.md) is complete.
The standalone stdio gateway, interactive chat cli, Matrix transport, Matrix E2EE support,
explicit invite accept/reject, and live Matrix smoke runner exist. Daemon/socket runtime
control is deferred by [ADR 0005](decisions/0005-use-stdio-json-lines-for-gateway-io.md)
until a concrete process-lifetime problem appears.

The public cli is now `umg chat` and `umg gateway`; top-level admin commands were removed.
Admin operations run inside an attached session: chat slash commands or gateway JSON-lines
admin commands. Chat is now a human-friendly wrapper over a shared gateway client path for
message/admin commands; see [ADR 0011](decisions/0011-chat-is-a-wrapper-over-gateway-protocol.md).

Last closeout verification passed locally:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `set -a && source state/matrix-smoke.env && set +a && UMG_MATRIX_SMOKE=1 npm run test:matrix-smoke`

## Known carry-forward notes

- `matrix-bot-sdk` has inherited npm audit findings through `request`; see
  [ADR 0009](decisions/0009-use-matrix-bot-sdk-for-first-matrix-transport.md).
- Interactive chat mode uses a hard process exit on quit; see
  [tech-debt 0001](techdebt/0001-bun-matrix-crypto-hard-exit.md).
- Rich client behavior is tracked in
  [client capability backlog](features/client-capability-backlog.md) and
  [rich message capabilities](features/rich-message-capabilities.md).
- Local Matrix smoke-test state exists under gitignored `state/`. Do not commit `state/`.
