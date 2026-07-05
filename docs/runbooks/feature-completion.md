# Feature Completion

Use this checklist after implementing any feature or fix, unless blocked by missing credentials,
failing tests, unexpected diffs, or unclear documentation placement.

## Verify

Before running checks, decide whether the change needs additional local tests. Add them first.

Run local checks:

```sh
npm run typecheck
npm run lint
npm test
```

Before running live smoke, decide whether Matrix smoke coverage should expand for new transport, protocol, or live Matrix behavior. Update it first when needed.

Then run the live Matrix smoke test when `state/matrix-smoke.env` exists:

```sh
set -a && source state/matrix-smoke.env && set +a && UMG_MATRIX_SMOKE=1 npm run test:matrix-smoke
```

## Document

Distill durable knowledge from completed feature notes into the narrowest stable docs:

- choices with rationale → `docs/decisions/`
- future-applying rules → `docs/CONVENTIONS.md` or another stable docs file
- repeatable steps → `docs/runbooks/`
- recurring fixes → `docs/lessons/`
- deferred deficiencies → `docs/techdebt/`
- user-facing behavior → `README.md`

Delete completed feature notes after distillation. Do not keep `status/complete` feature notes as durable docs.

Update `docs/_MEMORY.md` when active project state changes.

## Commit and Push

Inspect the final diff, then commit and push the current branch:

```sh
git status --short
git diff
git add <changed-files>
git commit
git push
```
