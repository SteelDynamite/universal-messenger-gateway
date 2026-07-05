# Bound Matrix media downloads by media type

## Context

Matrix media can be large. UMG must not fetch unbounded remote media, but bots need bounded local files for prompt shaping, text extraction, and image downscaling.

A single small cap protects runtime resources but blocks common screenshots. Images are transformable before prompting; arbitrary files are not.

## Options considered

### Metadata only

- Good: safest and cheapest.
- Bad: bots cannot inspect attachments.

### One 5 MiB cap for all media

- Good: simple and conservative.
- Bad: large screenshots are skipped before bots can downscale them.

### Separate bounded image cap

- Good: keeps arbitrary files small while allowing screenshots to be compressed downstream.
- Good: preserves explicit skip/failure metadata.
- Bad: images can use more disk/network/CPU than other media.

### Unbounded download then resize

- Good: maximizes successful image prompts.
- Bad: unacceptable resource risk.

## Decision

Use bounded Matrix media downloads.

Default caps:

- `mediaDownloadMaxBytes`: 5 MiB for non-image media.
- `imageMediaDownloadMaxBytes`: 25 MiB for image media.

Both settings are configurable. Oversized, disabled, or failed downloads still emit attachment metadata with `download.status` and `download.error`.

Exact Matrix history lookup by `messageId` may download the referenced media within the same bounds. Broad history scans may return media metadata but must not download every matched media item.

UMG only downloads and reports metadata. Bots own prompt transforms such as image compression and model-facing quality notices.

## Consequences

- UMG avoids unbounded Matrix media fetches.
- Bots can downscale common large screenshots.
- Large non-image files stay metadata-only by default.
- Operators can tune caps per deployment.
- Prompt quality degradation is visible only if the consuming bot reports it.
