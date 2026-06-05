# Feature Testing

Use this loop when a feature changes transport behavior, gateway protocol shape, or live
Matrix behavior. Update and run live smoke tests for every such change.

## Local Verification

Run local checks first:

```sh
npm run typecheck
npm run lint
npm test
```

The full test suite skips live Matrix smoke tests unless `UMG_MATRIX_SMOKE=1` is set.

## Live Matrix Smoke

Keep `tests/matrix-smoke.test.ts` current with transport/protocol behavior changes.

Use the gitignored local smoke env file when it exists:

```sh
set -a && source state/matrix-smoke.env && set +a && UMG_MATRIX_SMOKE=1 npm run test:matrix-smoke
```

Do not print credential values. If the env file is missing, use the variables documented in
[Matrix smoke tests](matrix-smoke-tests.md).

## Failure Loop

When live smoke fails:

1. Identify the failed wait/assertion and the protocol surface it exercises.
2. Prefer the smallest code fix over weakening the smoke assertion.
3. Rerun `npm run typecheck`, `npm run lint`, and the live smoke command.
4. Rerun `npm test` before reporting completion.

Document any new repeatable live-test setup or troubleshooting in the narrowest runbook.
