---
parent: "[[phase-1-standalone-gateway-and-cli]]"
tags:
  - status/complete
---

# Interactive dev chat cli

Add a human-usable cli harness for proving the gateway against live transports.

## Purpose

The raw stdio JSON-lines gateway is the contract. It is not pleasant for manual testing.
The interactive cli is a development harness that lets a maintainer see inbound messages,
select a current transport target, and send replies without hand-writing JSON.

This is not a product TUI. Keep it small until real testing exposes a need.

## Command

```bash
umg chat
```

`umg gateway` remains the stdio JSON-lines mode.

## Current implementation

The current implementation is a small in-process chat client over a shared gateway client
abstraction. It starts configured transports through the gateway client, prints inbound
events, auto-selects the first inbound target, sends normal typed lines as gateway
commands, auto-selects Matrix rooms with failed decryption so a bootstrap reply can be
sent, and supports target, invite, leave, status, configure, connect, disconnect, and quit
commands.

## Target shape

- Start or embed the gateway engine through a gateway client abstraction.
- Translate slash commands and normal text input into gateway commands.
- Render gateway events as a human-readable feed.
- Track recently seen `{ transport, chatId }` targets.
- Auto-select the first inbound target if no target is set.
- Send normal input text to the current target.
- Keep prompt context visible, e.g. `[matrix !room:server] >`.
- When input starts with `/`, show a selectable command list below the prompt.
- Command arguments use the same selectable flow where useful, e.g. `/target` first offers
  transports, then known chat IDs for the chosen transport.

## Slash Commands

- `/status` — show state, transport status, current target, and pending invite counts.
- `/configure <transport> [--enable|--disable] [--set key=value]...` — update transport config.
- `/connect <transport>` — enable and connect a transport.
- `/disconnect <transport>` — disable and disconnect a transport.
- `/target <transport> <chatId>` — set outbound target.
- `/leave [transport] [chatId]` — leave the current target, or the explicit target, where the
  transport supports it.
- `/accept <transport> <invite>` — accept a pending invite.
- `/reject <transport> <invite> [reason]` — reject a pending invite.
- `/quit` — disconnect and exit.

No `/help` command is required if slash-command discovery works. Add one only if the
completion UI proves insufficient.

## Command Completion

- `/` opens command suggestions.
- Arrow keys move through suggestions.
- Enter accepts the highlighted suggestion.
- Escape closes suggestions.
- `/target` completion is staged: transport first, then known chat ID.
- `/accept` and `/reject` completion is staged: transport first, then pending invites for
  that transport.
- Unknown chat IDs can still be typed manually.

The first implementation may use a simple readline-style prompt with redraws. A full-screen
TUI is deferred.

## Typing Indicator

Typing is deferred. When added, it should be represented in the gateway protocol first and
then exposed in chat.

## Room Membership

- Matrix does not autojoin; see [intentional invite membership](intentional-invite-membership.md).
- The chat cli surfaces invites explicitly so testing is visible.
- `/status` shows pending invite counts across transports.
- `/accept` and `/reject` complete pending invites.
- `/join` is deferred.

## Result

- A maintainer can run `umg chat`, receive a Matrix message, and type a normal text reply.
- The cli displays enough target context to avoid accidentally sending to the wrong room.
- The raw `umg gateway` JSON-lines mode exposes the same admin capabilities.
- Chat and gateway share the same gateway client path for admin and message commands.

## Deferred

- Full-screen TUI layout.
- Persistent scrollback.
- Message editing/reactions.
- Multi-pane target switching.
- Child-process gateway mode.
- Auth/routing policy.
- Rich profile and media features; see [client capability backlog](client-capability-backlog.md).
