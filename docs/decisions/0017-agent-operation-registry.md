# Agent operation registry

## Context

Embedded agents need bounded, discoverable access to transport state and normal participant actions. Separate bot-side schemas would drift from UMG APIs.

## Options considered

### Let each consumer wrap `GatewayClient`

- Good: no UMG-specific agent surface.
- Bad: duplicates schemas, help, bounds, and transport mappings.

### Expose raw transport methods

- Good: minimal adapter code.
- Bad: leaks transport differences and lacks generated discovery.

### Maintain one UMG operation registry

- Good: schemas, help, validation, bounds, and execution share one source.
- Good: consumers remain transport-neutral.
- Bad: UMG owns an additional public SDK surface.

## Decision

`AGENT_OPERATION_DESCRIPTORS` is the source of truth for bounded non-admin agent operations. `GatewayClient.executeAgentOperation()` validates and executes them. Operations use agent-friendly camelCase names, task groups, generated help, current transport source-of-truth data, and cursors where applicable.

Transport administration remains outside this registry. Consumers own their authorization and current-chat defaults.

## Consequences

- New useful non-admin APIs should update the registry.
- Operation help and schemas must not be duplicated manually.
- UMG owns normalized lookup and writes; consumers own access control and prompt shaping.
- Matrix-specific lookup remains behind transport interfaces.
