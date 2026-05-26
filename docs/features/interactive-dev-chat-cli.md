---
parent: "[[phase-1-standalone-gateway-and-cli]]"
tags:
  - status/planned
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

The first implementation is intentionally small: it starts configured transports,
prints inbound messages, auto-selects the first inbound target, sends normal typed
lines to the current target, auto-selects Matrix rooms with failed decryption so a
bootstrap reply can be sent, and supports `/target`, `/leave`, `/status`, and `/quit`.
In an interactive terminal, `/` opens command suggestions and `/target` / `/leave` offer
known targets. Joins, invites, and typing toggle are still pending.

## Shape

- Load `state/config.json` and start configured transports in-process.
- Print inbound messages as a feed.
- Track recently seen `{ transport, chatId }` targets.
- Auto-select the first inbound target if no target is set.
- Send normal input text to the current target.
- Keep prompt context visible, e.g. `[matrix !room:server] >`.
- When input starts with `/`, show a selectable command list below the prompt.
- Command arguments use the same selectable flow where useful, e.g. `/target` first offers
  transports, then known chat IDs for the chosen transport.

## Slash Commands

- `/target <transport> <chatId>` — set outbound target.
- `/leave [transport] [chatId]` — leave the current target, or the explicit target, where the
  transport supports it.
- `/join <transport> <room>` — join a room by room ID or alias, where the transport
  supports it.
- `/accept <transport>` — select and accept a pending invite for a transport.
- `/status` — show current target, connected transports, and pending invite counts.
- `/typing` — toggle typing indicator for the current target while enabled.
- `/quit` — disconnect and exit.

No `/help` command is required if slash-command discovery works. Add one only if the
completion UI proves insufficient.

## Command Completion

- `/` opens command suggestions.
- Arrow keys move through suggestions.
- Enter accepts the highlighted suggestion.
- Escape closes suggestions.
- `/target` completion is staged: transport first, then known chat ID.
- `/accept` completion is staged: transport first, then pending invites for that transport.
- Unknown chat IDs can still be typed manually.

The first implementation may use a simple readline-style prompt with redraws. A full-screen
TUI is deferred.

## Typing Indicator

Typing is stateful in the chat cli: `/typing` toggles whether the current target receives
periodic typing notifications while the user is composing.

One-shot typing pings are less useful interactively because many transports expire typing
state quickly.

## Room Membership

- Matrix auto-joins invites at the SDK layer today; replace this with
  [intentional invite membership](intentional-invite-membership.md).
- The chat cli should still surface joins and invites explicitly so testing is visible.
- `/status` shows pending invite counts across transports.
- `/accept <transport>` shows the selectable invite list for one transport.
- `/accept` with no transport can show transports that currently have invites.
- `/accept` and `/join` are transport capabilities: unsupported transports should report a
  clear "not supported" message.
- Joining by Matrix room alias is useful for manual tests; joining by room ID is enough for
  the first implementation if alias resolution is not already available.

## Done When

- A maintainer can run `umg chat`, receive a Matrix message, and type a normal text reply.
- The cli displays enough target context to avoid accidentally sending to the wrong room.
- The raw `umg gateway` JSON-lines mode still works unchanged.

## Deferred

- Full-screen TUI layout.
- Persistent scrollback.
- Message editing/reactions.
- Multi-pane target switching.
- Auth/routing policy.
- Rich profile and media features; see [client capability backlog](client-capability-backlog.md).
