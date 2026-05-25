# Compile first-party transports together

## Context

The gateway starts with first-party transports lifted from the source extension. A plugin
or per-transport build system could isolate heavy dependencies, but it would add API,
packaging, loading, and test complexity before the gateway itself works.

## Decision

Compile first-party transports into the gateway together for now. Runtime config decides
which compiled transports are enabled.

Do not add plugin loading, build profiles, or per-transport packages in Phase 1.

## Consequences

- Development stays simple while the gateway contract and transport seam settle.
- Runtime config can still keep unused transports disconnected.
- Install/build size may include dependencies for transports a user does not enable.
- Isolating transport dependencies through plugins or split packages remains desirable, but
  waits until the gateway has a real need and a stable transport API.
