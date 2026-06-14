---
parent: "[[matrix-mautrix-transport]]"
tags:
  - status/complete
---

# Matrix fresh-device trust smoke

Matrix smoke now covers fresh-device trust, not only decryptability.

## Scope

- Password-based smoke login creates fresh per-run devices when account passwords are configured.
- Default and focused mautrix smoke still verify encrypted send/receive.
- When recovery keys are configured, smoke asserts:
  - recovery-key import succeeds;
  - cross-signing keys are present;
  - the current device is self-signed;
  - Matrix E2EE health reports own-device trust.

## Rationale

Restart-with-same-DB smoke proves persistent decrypt. It does not prove a newly rotated device is trusted by clients.

## Related

- [Matrix E2EE device trust](../lessons/matrix-e2ee-device-trust.md)
- [Matrix mautrix transport](matrix-mautrix-transport.md)
- [Matrix smoke tests](../runbooks/matrix-smoke-tests.md)
