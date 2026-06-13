---
parent: "[[matrix-mautrix-transport]]"
tags:
  - status/backlog
---

# Matrix fresh-device trust smoke

Add Matrix smoke coverage for fresh-device trust, not only decryptability.

## Scope

- Rotate/create a fresh Matrix device in the smoke setup.
- Verify encrypted send/receive still works.
- Verify recovery-key import succeeds when configured.
- Verify cross-signing keys are present.
- Verify the current device is self-signed.
- Verify Matrix E2EE health reports own-device trust.
- If practical, detect Element-style unverified-owner warnings.

## Rationale

Restart-with-same-DB smoke proves persistent decrypt. It does not prove a newly rotated device is trusted by clients.

## Related

- [Matrix E2EE device trust](../lessons/matrix-e2ee-device-trust.md)
- [Matrix mautrix transport](matrix-mautrix-transport.md)
- [Matrix smoke tests](../runbooks/matrix-smoke-tests.md)
