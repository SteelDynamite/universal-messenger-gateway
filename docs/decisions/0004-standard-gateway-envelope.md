# Standardize the gateway envelope

## Context

The gateway needs one contract for inbound transport messages and outbound consumer
commands before the service shell and cli can be built.

## Decision

Use a versionless TypeScript contract in `src/protocol.ts` for Phase 1:

- inbound events: `message`, `reaction`, `invite`, and full `typing` snapshots
- command-result events: `admin_result` and `command_error`
- outbound commands: `send_message`, `send_file`, `send_reaction`, `set_typing`, `accept_invite`, `status`, `configure_transport`, `connect_transport`, and `disconnect_transport`
- transport names: `matrix`, `slack`, `discord`, `telegram`, `whatsapp`
- message references: `{ transport, chatId, messageId }`

`InboundMessage` carries the source extension fields plus optional `replyTo`, `threadTo`, `attachments`, and transport-provided structured `mentionedUserIds`.
`send_message` carries `{ transport, chatId, text }` plus optional `replyTo` and `threadTo`.
`typing` carries `{ transport, chatId, userIds, observedAt }` and replaces prior state for that chat.
`set_typing` carries `{ transport, chatId, typing, timeoutMs? }`.
`command_error` reports failed outbound commands without terminating `umg gateway`.

## Consequences

- The transport manager can normalize inbound messages without knowing the consumer.
- The cli and later orchestrator can share the same command types.
- Wire framing remains separate; stdio JSON-lines vs unix socket is still open.
