# Standardize the gateway envelope

## Context

The gateway needs one contract for inbound transport messages and outbound consumer
commands before the service shell and cli can be built.

## Decision

Use a versionless TypeScript contract in `src/protocol.ts` for Phase 1:

- inbound events: `message` and `reaction`
- command-result events: `admin_result` and `command_error`
- outbound commands: `send_message`, `send_reaction`, `send_typing`, `status`, `configure_transport`, `connect_transport`, and `disconnect_transport`
- transport names: `matrix`, `slack`, `discord`, `telegram`, `whatsapp`
- message references: `{ transport, chatId, messageId }`

`InboundMessage` carries the source extension fields plus optional `replyTo`, `threadTo`, and `attachments`.
`send_message` carries `{ transport, chatId, text }` plus optional `replyTo` and `threadTo`.
`send_typing` carries `{ transport, chatId }`.
`command_error` reports failed outbound commands without terminating `umg gateway`.

## Consequences

- The transport manager can normalize inbound messages without knowing the consumer.
- The cli and later orchestrator can share the same command types.
- Wire framing remains separate; stdio JSON-lines vs unix socket is still open.
