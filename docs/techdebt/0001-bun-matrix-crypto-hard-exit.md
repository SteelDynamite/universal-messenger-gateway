# 0001 — Bun Matrix Crypto Hard Exit

## Debt

Interactive `umg chat` exits through a hard process exit instead of a graceful transport
shutdown path.

## Why We Took It

Normal shutdown triggers a Bun + `matrix-sdk-crypto-nodejs` Rust teardown panic after Matrix
E2EE has been active. The chat harness is currently for live development testing, and a
reliable quit path is more useful than preserving graceful shutdown semantics here.

This is discovered debt: the issue appeared only after exercising live Matrix crypto.

## Retirement Condition

Replace the hard exit with graceful shutdown when one of these is true:

- `matrix-sdk-crypto-nodejs` no longer panics under Bun during teardown.
- The project runs Matrix crypto under a Node runtime for chat mode.
- The Matrix transport owns a proven shutdown sequence that stops sync and closes crypto
  without panicking.
