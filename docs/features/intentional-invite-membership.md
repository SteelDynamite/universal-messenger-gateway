---
parent: "[[interactive-dev-chat-cli]]"
tags:
  - status/planned
---

# Intentional Invite Membership

Replace Matrix autojoin with explicit invite visibility and accept/reject controls.

## Problem

The Matrix transport currently auto-joins invites through `AutojoinRoomsMixin`. That is useful
for early smoke testing but wrong for a gateway that needs deliberate room membership and
testable invite behavior.

## Shape

- Disable Matrix autojoin.
- Track pending invites per transport.
- Add transport capabilities for `listInvites`, `acceptInvite`, and `rejectInvite`.
- Surface pending invite counts in `/status`.
- Add `/accept <transport> <invite>` and `/reject <transport> <invite>`.
- Completion should offer transports with pending invites, then invite room IDs/display names.

## Done When

- Inviting the gateway account does not automatically join the room.
- `umg chat` shows the pending invite.
- A maintainer can accept or reject the invite intentionally.
- Automated Matrix smoke tests cover accept and reject paths.
