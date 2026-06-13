# Matrix E2EE device trust

## Problem

Encrypted Matrix messages can decrypt while Element still warns that the sender device is not verified by its owner.

The mautrix migration fixed Megolm room-key delivery first, but fresh bot devices still needed account cross-signing trust.

## Fix

Treat E2EE readiness as two separate checks:

1. Room keys arrive and timeline events decrypt.
2. The current device is self-signed by the account cross-signing identity.

Do not infer user-visible trust from successful decrypts.

## When to use

Use for Matrix SDK migrations, device rotations, crypto-store resets, and fresh-device deploys.

## Related

- [Matrix fresh-device trust smoke](../features/matrix-fresh-device-trust-smoke.md)
- [Matrix mautrix transport](../features/matrix-mautrix-transport.md)
- [Adopt mautrix Matrix transport](../decisions/0015-adopt-mautrix-matrix-transport.md)
