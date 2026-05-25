# universal-messenger-gateway Glossary

Terms with project-specific meaning. Keep alphabetical.

## Bridge (avoided)

A service that mirrors messages *bidirectionally* between two chat systems (e.g. a Matrix
room ↔ a Discord channel), so a message on either side appears on the other. This is
**not** what this project is; the term is avoided to keep the distinction sharp.

## cli

A test harness that drives the gateway over its standard I/O with no bot attached. Lets
the gateway be developed and exercised in isolation. An orchestrator takes its place when
a bot is connected.

## Gateway

The portal a transport connects to on one side and a bot connects to on the other. Owns
the normalized message envelope and all transport state (including the Matrix
crypto/session store). Pure transport-layer — no bot logic, no routing.

## Orchestrator

The consumer that connects a bot to the gateway: it sits where the cli sits and drives
the gateway's standard I/O on the bot's behalf. Out of scope for the gateway itself.

## Transport

An adapter to a *single* chat service. Messages are adapted to and from the gateway's
standard I/O, not mirrored to another service. One transport per platform (Matrix, Slack,
Discord, Telegram, WhatsApp). The term is kept deliberately — it avoids colliding with
"channel"/"room", which already mean a conversation *inside* a chat platform.
