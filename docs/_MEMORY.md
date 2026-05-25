# universal-messenger-gateway — Project State

Current active goal: stand up the standalone gateway + cli (Phase 1).

## Active work

- [Phase 1 — Standalone gateway + cli](features/phase-1-standalone-gateway-and-cli.md)

## Open decisions to settle

- The standard message envelope — inbound largely exists; outbound = target transport +
  chat id + text (reply/edit refs later). Pin first.
- cli↔gateway I/O mechanism: stdio JSON-lines vs unix socket.
- Transport load model: compiled-in + config-enabled now; plugin-dir later if earned.
- State dir env var + default path.

## Scratchpad

- Repo scaffolded: README, LICENSE (MIT), docs vault. Transport layer not yet lifted from
  the source extension.
