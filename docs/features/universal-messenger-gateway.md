# universal-messenger-gateway

Roadmap dashboard. Phases are flat notes in this folder; status via tags.

## Phases

- [Phase 1 — Standalone gateway + cli](phase-1-standalone-gateway-and-cli.md) — active
- [Phase 2 — Connect an agent](phase-2-connect-an-agent.md) — backlog

## Status

### In Progress

```dataview
LIST
FROM "docs/features" AND #status/in-progress
SORT file.name ASC
```

### Backlog

```dataview
LIST
FROM "docs/features" AND #status/backlog
SORT file.name ASC
```

### Complete

```dataview
LIST
FROM "docs/features" AND #status/complete
SORT file.name ASC
```
