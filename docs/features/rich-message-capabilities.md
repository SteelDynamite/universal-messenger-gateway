---
parent: "[[client-capability-backlog]]"
tags:
  - status/in-progress
---

# Rich Message Capabilities

Extend the gateway protocol beyond plain text send/receive so it can represent real chat
client behavior.

## Scope

- Threads.
- Reply-to context.
- Reactions with message context.
- Sending reactions to specific messages.
- Message IDs and references on all supported inbound/outbound surfaces.
- Inbound media metadata.
- Future room-client behavior: edits, receipts, media downloads, and profile context.

## Protocol Direction

The gateway should keep message relationships explicit and transport-neutral. A bot or test
harness should not need Matrix-specific event IDs except as opaque IDs inside normalized
references.

Likely surfaces:

- Inbound message includes `messageId`, optional `replyTo`, optional `thread`, optional
  relationship metadata, and optional `attachments`.
- Inbound reaction includes `{ transport, chatId, messageId, reaction, sender }` and a
  reference to the reacted-to message.
- Outbound send can include `replyTo` and thread targeting.
- Outbound reaction command targets a specific message reference.

## Done When

- Matrix thread replies are represented in normalized inbound events.
- Matrix replies include usable context for the referenced message.
- Matrix reactions are received with enough context to display and route them.
- Matrix reactions can be sent to a specific prior message.
- Matrix inbound media events emit attachment metadata.
- Automated Matrix smoke tests cover the above.

## Implemented media handling

Inbound Matrix `m.image`, `m.file`, `m.audio`, and `m.video` events produce an attachment envelope with:

- `mediaId` from Matrix `url` or encrypted-file `file.url`.
- `kind`.
- `fileName` / `description` from `body`.
- `mimeType` and `sizeBytes` from `info` when present.
- `download` status metadata.

The mautrix Matrix transport downloads attachments up to `mediaDownloadMaxBytes` (default 5 MiB) into `state/media/` and reports `localPath`, downloaded byte count, and SHA-256. Oversized or failed downloads still emit the message with skipped/failed download metadata.
