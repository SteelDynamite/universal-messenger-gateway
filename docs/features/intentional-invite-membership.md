---
parent: "[[interactive-dev-chat-cli]]"
tags:
  - status/complete
---

# Intentional Invite Membership

Matrix invite membership is explicit: pending invites are visible, and joins happen only
after accept.

## Problem

The Matrix transport used to auto-join invites through `AutojoinRoomsMixin`. That was useful
for early smoke testing but wrong for a gateway that needs deliberate room membership and
testable invite behavior.

## Shape

- Disable Matrix autojoin.
- Track pending invites per transport.
- Emit normalized invite events to SDK/stdio consumers.
- Add transport capabilities for `listInvites`, `acceptInvite`, and `rejectInvite`.
- Surface pending invite counts in `/status`.
- Add `/accept <transport> <invite>` and `/reject <transport> <invite>`.
- Completion should offer transports with pending invites, then invite room IDs/display names.

## Done When

- Inviting the gateway account does not automatically join the room.
- `umg chat` shows the pending invite.
- A maintainer can accept or reject the invite intentionally.
- Automated Matrix smoke tests cover accept and reject paths.

## Result

`TransportProvider` exposes optional invite methods. Matrix tracks `room.invite` events,
emits normalized invite events, and does not autojoin by itself. `umg chat` exposes `/accept
<transport> <invite>` and `/reject <transport> <invite> [reason]`, and `/status` shows
pending invite counts.

The live Matrix smoke test covers no-autojoin, explicit accept, encrypted round-trip after
accept, and explicit reject without joining.
