# Keep "transport" as the per-platform adapter term

## Context

The per-platform adapter could be called a "channel," but "channel" and "room" already
mean a conversation *inside* a chat platform. The source extension already used
"transport" (`ITransportProvider`, the transport manager).

## Decision

Keep **transport** as the name for a per-platform adapter. Avoid "bridge" entirely — a
bridge mirrors two chat systems bidirectionally, which this project does not do.

## Consequences

- No rename churn against the inherited code.
- Vocabulary stays unambiguous; see the [glossary](../GLOSSARY.md).
