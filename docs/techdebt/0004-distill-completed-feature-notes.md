# Distill completed feature notes

## Debt

Some existing notes in `docs/features/` still use `status/complete`.

Feature notes are planning/workflow docs, not durable memory. Completed feature knowledge should live in decisions, runbooks, conventions, lessons, techdebt, or README, then the feature note should be deleted.

## Impact

Agents may treat stale completed feature notes as source of truth or duplicate durable docs.

## Why We Took It

This repo predates the Forge project-memory policy that completed feature notes are distilled and deleted.

## Retirement Condition

Review each `status/complete` feature note, move any durable current knowledge to the narrowest stable doc, then delete the feature note.

No `docs/features/*.md` file contains `status/complete`.
