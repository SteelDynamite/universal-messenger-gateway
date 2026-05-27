# Windows Matrix Smoke Development

## Problem

The normal tests and live Matrix smoke tests work on Linux, but Windows development currently has local failures that block the same verification loop.

Observed on Windows/MSYS:

- `bun` was not initially on `PATH`; using the full Bun path was required until the shell/editor is restarted.
- Unit tests exposed Windows path separator assumptions in state/config path expectations.
- Matrix secret-file permission tests treated Windows stat modes like POSIX modes; `chmod 600` still appeared as mode `666`.
- `bun run lint` reported CRLF/LF formatting issues in existing files.
- Live Matrix smoke reached the encrypted message phase, then account B failed to decrypt account A's message: `Can't find the room key to decrypt the event`.

## What needs to be done

1. Make path-related tests platform-neutral without weakening production path behavior.
2. Replace POSIX-only secret permission assertions on Windows with either:
   - Windows ACL-aware checks, or
   - explicit Windows skips with documented coverage limits.
3. Normalize line endings for Biome on Windows, likely via `.gitattributes` and/or editor settings.
4. Re-test Matrix E2EE on Windows with clean per-run smoke state to avoid stale crypto stores and old encrypted rooms.
5. Inspect Matrix crypto room-key sharing on Windows:
   - confirm whether `matrix-bot-sdk` and `@matrix-org/matrix-sdk-crypto-nodejs` request field shapes differ by version,
   - verify whether room keys are being sent as `m.room_key` or withheld as `m.room_key.withheld`,
   - confirm whether peer devices are trusted/cross-signed before the first encrypted message.
6. Add targeted diagnostics for live smoke failures that do not print credentials.
7. Decide whether Windows smoke should use fresh state by default or a cleanup command for the gitignored smoke state.

## Unanswered gaps

1. Is the Windows smoke failure caused by stale local crypto state, untrusted peer devices, SDK binding differences, or a combination?
2. Does upgrading `matrix-bot-sdk` or `@matrix-org/matrix-sdk-crypto-nodejs` remove the room-key sharing issue?
3. Are the smoke accounts' Windows devices expected to be cross-signed/trusted, or should the smoke harness explicitly establish trust?
4. Should Windows enforce Matrix secret-file permissions through ACL inspection, or document that POSIX mode checks are Linux/macOS-only?
5. What is the intended repository-wide line-ending policy for Windows contributors?

## Reason deferred

Created as tech debt due to lack of time. The live Matrix failure requires slower end-to-end investigation with real accounts and crypto state, and quick fixes risk weakening smoke coverage or hiding a genuine Windows E2EE setup problem.
