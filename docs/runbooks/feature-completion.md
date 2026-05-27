# Feature Completion

Use this checklist after implementing any feature or fix, unless blocked by missing credentials,
failing tests, unexpected diffs, or unclear documentation placement.

## Verify

Run local checks:

```sh
bun run typecheck
bun run lint
bun run test
```

Then run the live Matrix smoke test when `state/matrix-smoke.env` exists:

```sh
set -a && source state/matrix-smoke.env && set +a && UMG_MATRIX_SMOKE=1 bun run test:matrix-smoke
```

## Document

Update the narrowest relevant documentation in `docs/`. Update `docs/_MEMORY.md` when
active project state changes.

## Commit and Push

Inspect the final diff, then commit and push the current branch:

```sh
git status --short
git diff
git add <changed-files>
git commit
git push
```
