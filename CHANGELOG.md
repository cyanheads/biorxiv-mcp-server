# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-08-09

biorxiv_get_fulltext caches extracted articles for offset paging, classifies HTTP 429 as a retryable rate_limited error, and resolves DOIs against both servers by default (#36, #37, #38)

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-08-09

biorxiv_get_preprint and biorxiv_get_published_version distinguish upstream failures from not-found; biorxiv_list_recent surfaces exhausted cursors and failed servers (#32, #34, #35, #39)

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-11

Add biorxiv_get_fulltext for full-text retrieval via HTML extraction and an author filter on biorxiv_search_preprints (#19)

## [0.1.18](changelog/0.1.x/0.1.18.md) — 2026-07-11

Add EuropePMC cursor pagination to biorxiv_search_preprints, fix biorxiv_list_recent mixing unfiltered records into server-exclusive category results, and reject calendar-impossible dates before upstream calls (#27, #29, #30)

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-07-11

Strip leaked Highwire/JATS markup from titles and abstracts, render every revision field in biorxiv_get_preprint's content[], and remove implementation-detail leaks from advertised tool descriptions (#25, #26, #31)

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-07-11

Adopt @cyanheads/mcp-ts-core ^0.10.14; Socket supply-chain scanner + minimumReleaseAge install guard, Dockerfile hardening, and SERVER_VERSION now derives from package.json instead of a hardcoded, drifted literal (#28)

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9; check-dependency-specifiers devcheck step, lint:packaging plugin-manifest checks, fresh-scaffold devcheck guards, ctx.content media collector

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6; explicit server identity, ctx.enrich.total() in search, Dockerfile version label and healthcheck

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-06-04

Fix misleading field references in biorxiv_get_published_version; surface enrichment_error reason in biorxiv_search_preprints

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-06-02

adopt @cyanheads/mcp-ts-core ^0.9.21 — per-request log context fix, secret-stripped fetch errors, withRetry fail-fast

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-05-31

biorxiv_list_recent: remove dead DataCanvas integration (canvas_id output, spillover handler, CANVAS_PROVIDER_TYPE config)

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-05-30

enrichment adoption on biorxiv_search_preprints and biorxiv_list_recent: query echo, true EuropePMC hitCount, empty-result guidance via typed enrichment block; totalFound now reflects upstream hitCount

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-28

mcp-ts-core ^0.9.13: 413 body cap, HTTP session-init gate, quieter client-error logging, GET /mcp keywords; MCPB placeholder fix; landing inventory unlocked

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-24

services/shared.ts extraction, search-preprints format() simplification, mcp-ts-core ^0.9.6 → ^0.9.9

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Fix server=\"both\" category routing and medRxiv DOI enrichment.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

Bug fixes across error contracts, search enrichment, validation, and formatting in bioRxiv tools.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Pre-launch polish: code simplification in list-recent tool and Europe PMC service, Docker docs added, AGENTS.md added, import order and comment cleanup.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Field-test bug fixes: DOI encoding, funder parsing, pagination total, EuropePMC server filter, date validation, User-Agent, new DOI prefix.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Error code semantics for domain validation; mcp-ts-core ^0.9.5 → ^0.9.6.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

mcp-ts-core ^0.9.5, MCPB bundle support, optional-chain lint fixes.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-21

Full tool surface implementation: five bioRxiv/medRxiv tools, two API services, and tests.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-21

Initial scaffold from @cyanheads/mcp-ts-core; tool-surface design for bioRxiv/medRxiv API.
