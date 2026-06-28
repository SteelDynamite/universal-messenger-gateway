---
parent: "[[universal-messenger-gateway]]"
tags:
  - status/backlog
---

# Client capability backlog

Longer-term chat-client capabilities that are useful but not required to prove Phase 1.

## Identity

- Set display name per transport identity.
- Set profile picture / avatar per transport identity.
- Report current identity metadata in cli status.

## Rooms And Membership

- List joined rooms/channels.
- List pending invites.
- Accept or reject invites.
- Join rooms by ID or alias where supported.
- Leave rooms.
- Disable Matrix autojoin and require intentional invite handling; see
  [intentional invite membership](intentional-invite-membership.md).

## Media

- Send files by path.
- Send images by path.
- Add richer previews/transforms beyond bounded downloaded media metadata.

## Message Features

- Reply-to references.
- Thread context and thread replies.
- Message edits.
- Reactions with message context.
- Send reactions to specific messages.
- Read receipts where useful.
- Rich message capabilities are tracked in
  [rich message capabilities](rich-message-capabilities.md).

## Test Automation

- Two-account live Matrix smoke tests; see
  [automated Matrix smoke tests](automated-matrix-smoke-tests.md).

## Cli Experience

- Persistent scrollback.
- Search recent messages.
- Multi-target panes.
- Safer target confirmation for first send to a room.
