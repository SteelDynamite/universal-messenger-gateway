---
parent: "[[interactive-dev-chat-cli]]"
tags:
  - status/complete
---

# Chat input editing QoL

Improve `umg chat` raw-mode input enough that it behaves like a normal terminal prompt for manual gateway testing.

## Scope

The chat prompt remains a small redraw-based development harness, not a full TUI. Input editing should support common terminal conventions while preserving existing slash-command suggestions.

## Behavior

- Plain typed characters insert at the cursor.
- Multi-character paste inserts at the cursor.
- Bracketed paste (`ESC [ 200 ~` ... `ESC [ 201 ~`) inserts pasted text at the cursor.
- Pasted newlines become spaces so a paste cannot accidentally submit multiple chat commands.
- Left/right arrows move by character.
- Home/End and Ctrl+A/Ctrl+E move to line start/end.
- Backspace deletes before the cursor.
- Delete and Ctrl+D delete under the cursor; Ctrl+D exits when the input is empty.
- Ctrl+U deletes before the cursor.
- Ctrl+K deletes after the cursor.
- Ctrl+W deletes the previous word.
- Ctrl+L redraws the current prompt.
- Up/down keep navigating visible suggestions.
- Escape closes suggestions.
- Enter accepts the selected suggestion when one is visible, otherwise submits the current buffer.

## Acceptance criteria

- Existing chat CLI behavior and slash commands continue to work.
- Cursor-aware editing can compose and send a message with inserted text in the middle.
- Paste can insert a full message.
- Bracketed paste strips wrapper sequences and normalizes newlines to spaces.
- Prompt rendering places the terminal cursor at the logical input cursor.
