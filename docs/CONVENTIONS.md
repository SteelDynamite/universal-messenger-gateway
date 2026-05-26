# universal-messenger-gateway Conventions

## Language & tooling

Inherited from the source extension:

- TypeScript, ES2022, ES module syntax.
- **Build:** `tsc` (`npm run build`); typecheck with `tsc --noEmit` (`npm run typecheck`).
- **Lint / format:** Biome — `npm run lint` (`biome check src/`), `npm run lint:fix`.
- **Tests:** Vitest (`npm run test` → `vitest run`); property tests via fast-check.

## Code style

- One transport per file under `src/transports/`, each implementing the transport
  interface.
- The gateway core stays free of platform SDK imports; platform code lives in transports.
- No bot/agent logic in the gateway.

## Documentation style

- Few words. Describe current state, not history.
- Narrowest correct file; link rather than duplicate.
- Standard relative Markdown links between docs — they render on GitHub and resolve in
  Obsidian.
- ADRs are the one place that records the *why* of a decision.
- Tech-debt notes describe debt being carried, why it was accepted, and what would retire it.

## Git

- Present-tense commit subjects.
- Never commit runtime state — transport config and the Matrix crypto store are
  gitignored.
