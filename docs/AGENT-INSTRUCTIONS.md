# universal-messenger-gateway — Agent Instructions

## Repository layout

- `README.md` — user-facing overview, at the repo root (also the Obsidian vault root).
- `docs/` — documentation vault (this file lives here).
- `src/` — source (transports, gateway core, cli), as code lands.
- `LICENSE` — MIT.

This repo is opened as an Obsidian vault at its root; all documentation lives in `docs/`.

## Project documentation

Everything not explicit or obvious from reading the source belongs in `docs/`. Use the
narrowest correct file. Keep entries short. Describe current state, not history — except
ADRs, which exist to record a decision.

## Documentation routing

- User docs → `README.md`
- Developer mental model → `docs/CONTRIBUTING.md`
- Code / docs rules → `docs/CONVENTIONS.md`
- Vocabulary → `docs/GLOSSARY.md`
- Decisions (why) → `docs/decisions/NNNN-subject.md`
- Procedures (how) → `docs/runbooks/`
- Features / phases / tasks → `docs/features/`
- Technical debt → `docs/techdebt/NNNN-subject.md`
- Active work state → `docs/_MEMORY.md`

## Boundaries

- This is a **bot-agnostic** gateway. Document it in terms of "a bot/agent," not any
  specific agent. The only reference to its origin is that it refactors the
  pi-messenger-bridge extension.
- Deployment, orchestration, and any specific agent's behavior are out of scope for this
  repo.

## Active work

Track in-flight work in `docs/_MEMORY.md`.
