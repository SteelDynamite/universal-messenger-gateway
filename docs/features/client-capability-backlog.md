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

## Media

- Receive files and expose local paths or metadata in the gateway event stream.
- Send files by path.
- Receive images with useful metadata.
- Send images by path.

## Message Features

- Reply-to references.
- Message edits.
- Reactions.
- Read receipts where useful.

## Cli Experience

- Persistent scrollback.
- Search recent messages.
- Multi-target panes.
- Safer target confirmation for first send to a room.
