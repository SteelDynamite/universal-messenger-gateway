# universal-messenger-gateway

A standalone, bot-agnostic gateway that speaks many chat platforms and exposes one
standardized I/O for a single bot.

It lifts the transport layer out of
[`pi-messenger-bridge`](https://github.com/tintinweb/pi-messenger-bridge) and makes it
its own thing:

- **transport** — an adapter to a single chat service (Matrix, Slack, Discord,
  Telegram, WhatsApp). One transport per platform. Messages are *adapted* to and from
  the gateway's standard I/O, not mirrored between platforms.
- **gateway** — the portal a transport connects to on one side and a bot on the other.
  Owns the normalized message envelope and all transport state (including the Matrix
  crypto/session store). Pure transport-layer: no agent logic.
- **cli** — a test harness that drives the gateway over its standard I/O with no agent
  involved, so the gateway can be developed and exercised in complete isolation. An
  orchestrator swaps in where the cli sits when it is time to connect an agent.

## Status

Early — scaffolding. See the phased plan for scope.

## License

MIT — see [LICENSE](LICENSE). Derived in part from
[pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) (MIT); upstream
attribution is preserved on the transport-layer code as it is imported.
