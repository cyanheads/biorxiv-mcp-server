# biorxiv-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `biorxiv_get_preprint` | Fetch full metadata, abstract, all revision history, full-text/PDF links, and published-journal DOI for one or more preprints by DOI. Each DOI call returns all revisions in a single response; includes the published journal DOI and journal name when the preprint has been accepted. | `dois: string[]` (1–10, DOI format `10.1101/YYYY.MM.DD.NNNNNN`); `server?: "biorxiv" \| "medrxiv" \| "both"` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `biorxiv_list_recent` | List preprints posted or updated within a date interval, optionally scoped to one server or subject category. Returns 30 preprints per page (fixed by the API); use `cursor` to step through additional pages. Category filtering is applied server-side. Response includes `total` count for calculating remaining pages. | `start_date: string` (YYYY-MM-DD); `end_date: string`; `server?: "biorxiv" \| "medrxiv" \| "both"`; `category?: string` (server-side filter); `cursor?: number` (integer offset, default 0) | `readOnlyHint: true`, `openWorldHint: true` |
| `biorxiv_search_preprints` | Search preprints by keyword using EuropePMC for relevance ranking, then enrich matching DOIs with full bioRxiv/medRxiv metadata. Covers both servers by default. Surfaces preprints that may not yet have a PubMed record. EuropePMC indexes new preprints within 1–2 days of posting. | `query: string`; `server?: "biorxiv" \| "medrxiv" \| "both"`; `date_from?: string` (YYYY-MM-DD); `date_to?: string`; `limit?: number` | `readOnlyHint: true`, `openWorldHint: true` |
| `biorxiv_get_published_version` | Resolve a preprint DOI to its full journal publication record (journal DOI, journal name, published date), or confirm a preprint is not yet published. Use when the preprint's `published` field is non-null and you need richer crosswalk metadata than `biorxiv_get_preprint` provides. | `doi: string`; `server?: "biorxiv" \| "medrxiv"` (defaults to `biorxiv`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `biorxiv_list_categories` | List valid subject category strings for bioRxiv and medRxiv, usable as the `category` filter in `biorxiv_list_recent`. Returns the static taxonomy for both servers. | _(none)_ | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |

### Resources

No standalone resources. All data is reachable through the tool surface and tool-only clients are the primary target.

### Prompts

None. This is a data-retrieval server; no recurring interaction templates are needed.

---

## Overview

biorxiv-mcp-server exposes bioRxiv and medRxiv preprint data via the Cold Spring Harbor Lab API (`api.biorxiv.org`). It covers ~400K bioRxiv and ~70K medRxiv preprints — life-sciences and clinical research published before, and often months ahead of, journal peer review.

Primary use cases: monitoring new preprints in a field, resolving DOIs to full metadata and revision history, tracking the preprint-to-journal publication crosswalk, and keyword search with relevance ranking (via EuropePMC enrichment). No auth is required. Both servers share one API and are addressed via a `server` parameter; most tools default to querying both.

Pairs naturally with **pubmed-mcp-server** (post-publication side), **openalex-mcp-server** (citation analytics and author disambiguation), and **crossref-mcp-server** (DOI metadata).

---

## Requirements

- Read-only access to `https://api.biorxiv.org/` — no auth, no write operations
- Polite `User-Agent` header including a mailto address (env var `BIORXIV_MAILTO`)
- Rate limit is undocumented; implement gentle retry with exponential backoff
- Keyword search via EuropePMC (no API key required for basic search) with bioRxiv metadata enrichment — EuropePMC is the relevance engine; the bioRxiv API is the canonical data source
- Category taxonomy is static (hardcoded); bioRxiv has ~30 categories, medRxiv ~50
- DOI is the primary key across all tools
- Pagination via integer cursor (numeric offset) for `biorxiv_list_recent`; offset-based for EuropePMC search results. The listing endpoint returns exactly 30 results per page (fixed by the API; no `limit` parameter is accepted).
- Category filtering on `biorxiv_list_recent` is server-side (query parameter `?category=…`), not client-side — the API response's `category` field in the `messages` envelope confirms the active filter.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `BiorxivApiService` | `api.biorxiv.org` — details, publications, pubs (crosswalk) endpoints | `biorxiv_get_preprint`, `biorxiv_list_recent`, `biorxiv_get_published_version` |
| `EuropePmcService` | EuropePMC REST API search endpoint — preprint search by keyword | `biorxiv_search_preprints` |

**BiorxivApiService resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Wraps full fetch + parse pipeline; uses `withRetry` |
| Backoff | 500ms base (rate-limit unknown; conservative); 3 attempts |
| HTTP errors | `fetchWithTimeout` handles non-OK → `ServiceUnavailable` |
| Parse failure | Detects HTML error pages, throws transient not `SerializationError` |

**EuropePmcService resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Same `withRetry` wrapper |
| Backoff | 300ms base; EuropePMC recovers quickly from transient errors |
| Field selection | Request `doi,title,authorString,firstPublicationDate,abstractText` only |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `BIORXIV_MAILTO` | No | Email address included in the `User-Agent` header (e.g. `your@email.com`). Optional, but recommended for polite API access. |
| `BIORXIV_API_BASE_URL` | No | Override the API base URL. Defaults to `https://api.biorxiv.org`. |
| `EUROPEPMC_API_BASE_URL` | No | Override EuropePMC base URL. Defaults to `https://www.ebi.ac.uk/europepmc/webservices/rest`. |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with Zod schema for all env vars
2. **BiorxivApiService** — details, publications, and pubs (crosswalk) endpoint wrappers with retry
3. **EuropePmcService** — preprint search endpoint wrapper with retry
4. **`biorxiv_list_categories`** — trivial static-data tool; validates service wiring without a live call
5. **`biorxiv_list_recent`** — date-range listing; exercises BiorxivApiService pagination
6. **`biorxiv_get_preprint`** — batch DOI lookup; exercises revision and details endpoints
7. **`biorxiv_get_published_version`** — crosswalk endpoint; single-call tool
8. **`biorxiv_search_preprints`** — fan-out: EuropePMC search → DOI list → BiorxivApiService enrichment

Each step is independently testable against the live API.

---

## Domain Mapping

| Noun | Operations | API Endpoint | Notes |
|:-----|:-----------|:-------------|:------|
| Preprint (details) | get by DOI (all revisions) | `/details/{server}/{doi}` | Returns all revisions in `collection[]` in a single call. Fields: `title`, `authors`, `author_corresponding`, `author_corresponding_institution`, `doi`, `date`, `version`, `type`, `license`, `category`, `jatsxml`, `abstract`, `funder`, `published` (journal DOI or `"NA"`), `server`. |
| Preprint (listing) | list by date interval | `/details/{server}/{start}/{end}/{cursor}` | `cursor` is an integer offset (0, 30, 60, …). Always returns exactly 30 results per page. Response `messages[0]` includes `total`, `count_new_papers`, and the active `category` filter value. Category is passed as a query parameter: `?category=neuroscience`. |
| Published version (crosswalk) | resolve preprint→journal | `/pubs/{server}/{doi}` | Returns `preprint_doi`, `published_doi`, `published_journal`, `published_date`, `preprint_title`, `preprint_authors`, `preprint_category`, `preprint_date`, `preprint_abstract`, `preprint_author_corresponding`, `preprint_author_corresponding_institution`. Richer than the `published` field in details. |
| Categories | list | Hardcoded taxonomy (static) | No API endpoint; static list maintained in code. |
| EuropePMC search | full-text search returning DOIs | `GET /search?query=…&resulttype=lite&filter=preprint` | Returns ranked DOIs used to drive enrichment via details endpoint. |

The bioRxiv API uses `{server}` as either `biorxiv` or `medrxiv`; no multi-server single call exists. Fan-out to both servers happens in the service layer via `Promise.all`, results merged and deduplicated by DOI.

**`biorxiv_list_recent` pagination with `server="both"`:** when fanning out across both servers, each server has its own independent `total` and `cursor`. The response must surface per-server pagination state (e.g., `{ biorxiv: { cursor: 30, total: 550 }, medrxiv: { cursor: 30, total: 210 } }`) so callers know how to advance each server's cursor independently. A single merged `cursor` number is ambiguous and wrong here.

---

## Workflow Analysis

### `biorxiv_search_preprints` (fan-out workflow)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `EuropePmcService.search(query, filter=preprint)` | Ranked DOI list with titles |
| 2a | `BiorxivApiService.getDetails(doi, "biorxiv")` ×N | Enrich matching DOIs on bioRxiv — one call per DOI returns all revisions |
| 2b | `BiorxivApiService.getDetails(doi, "medrxiv")` ×N | Enrich matching DOIs on medRxiv (only when `server=both` and DOI source is ambiguous) |
| — | Merge by DOI, surface `server` field on each result | Deduplication |

Steps 2a/2b run in parallel via `Promise.allSettled`; enrichment failures degrade to EuropePMC-only metadata for that record, surfaced in a `partial_results` flag. EuropePMC's `doi` field identifies the server; when it's known (e.g., `10.1101/` prefix = bioRxiv), skip the parallel medRxiv call.

### `biorxiv_get_preprint` (batch lookup)

`/details/{server}/{doi}` returns **all revisions** in a single `collection[]` response. No revision enumeration loop is needed.

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `BiorxivApiService.getDetails(doi, server)` for each DOI × each server | One call per (DOI, server) pair; each call returns all revisions for that preprint |
| — | Merge per-DOI results; surface `server` field; report per-DOI failures in `failed[]` | Partial success |

When `server="both"`, each DOI generates two calls (biorxiv + medrxiv) run in parallel via `Promise.allSettled`. When `server` is specified, one call per DOI. Partial success reported per-DOI in `failed[]`. Note: if a DOI exists only on bioRxiv, the medrxiv call returns an empty collection (not an error) — this is not a failure.

---

## Error Contracts

| Tool | Reason | Code | When | Retryable? |
|:-----|:-------|:-----|:-----|:-----------|
| `biorxiv_get_preprint` | `doi_not_found` | `NotFound` | DOI resolves to empty collection on all requested servers | No — verify DOI format (must be `10.1101/…`) |
| `biorxiv_get_preprint` | `invalid_doi_format` | `InvalidParams` | Input DOI does not match `10.\d{4}/` pattern | No — fix and retry |
| `biorxiv_list_recent` | `invalid_date_range` | `InvalidParams` | `end_date` is before `start_date`, or either date is malformed | No — fix and retry |
| `biorxiv_list_recent` | `invalid_category` | `InvalidParams` | Category string not in taxonomy (server returns empty with no error) | No — use `biorxiv_list_categories` to get valid values |
| `biorxiv_search_preprints` | `search_unavailable` | `ServiceUnavailable` | EuropePMC search endpoint is unreachable or returns 5xx | Yes — retry after delay |
| `biorxiv_get_published_version` | `doi_not_found` | `NotFound` | Crosswalk endpoint returns empty collection — preprint may not be published yet | No — check `published` field in `biorxiv_get_preprint` first |
| All | _(baseline)_ | `ServiceUnavailable` | `api.biorxiv.org` is unreachable or returns 5xx | Yes |

---

## Known Limitations

- **bioRxiv native search is not used** — the `/search` endpoint is weak and undocumented. EuropePMC provides relevance-ranked results but may lag new preprints by 1–2 days.
- **Full-text retrieval not included** — bioRxiv exposes PDF URLs and a TDM API for full-text XML. PDF/full-text parsing is deferred; `biorxiv_get_preprint` returns the PDF URL (`jatsxml` field) and abstract; the caller can fetch the PDF directly from the DOI URL.
- **Listing page size is fixed at 30** — the API does not accept a `limit` parameter; pagination requires stepping by cursor offset (0, 30, 60, …). The `total` field in the response lets clients calculate total pages.
- **Category filter on listing is server-side** — the API filters by category; invalid category strings return empty results without an error. Validate against `biorxiv_list_categories` before filtering.
- **No multi-server batch endpoint** — the API requires separate calls per server; the service layer fans out via `Promise.all`.
- **Rate limits undocumented** — implement conservatively; if 429s emerge in practice, reduce concurrency or increase backoff.
- **Category list is hardcoded** — no API endpoint provides the taxonomy; the static list may drift as new categories are added.
- **`format()` must be content-complete** — Claude Desktop reads `content[]` from `format()`, not `structuredContent`. Every tool's `format()` function must render all fields the LLM needs (revisions, published DOI, category, abstract, pagination state) in markdown, not just a count or title. This is particularly important for `biorxiv_get_preprint` where the revision list and crosswalk data are the primary output.

---

## Decisions Log

### Answered questions

- **Search relevance: EuropePMC fallback or date-range only?** → EuropePMC fallback implemented as `biorxiv_search_preprints`. Rationale: date-range browsing alone forces the agent to read hundreds of entries to find relevant work; relevance search is the primary discovery workflow and EuropePMC indexes bioRxiv/medRxiv reliably.
- **Full-text retrieval: in scope?** → Deferred. `biorxiv_get_preprint` returns the PDF URL and abstract; parsing PDF/TDM XML is a separate concern with significant complexity and no clear agent workflow that requires it vs. using the URL directly.
- **Category taxonomy: hardcode or fetch dynamically?** → Hardcoded static list. No API endpoint provides it; the taxonomy changes infrequently; a dedicated `biorxiv_list_categories` tool exposes it so agents can discover valid values without baking category strings into tool parameters.
- **Two-server fan-out: default scope?** → Default to both servers (`"both"`) with optional `server` parameter to scope down. Rationale: agents asking about a topic don't typically want to miss medRxiv results when asking about bioRxiv and vice versa.

### Options declined

- **`biorxiv_search_preprints` using the native `/search` endpoint** → Declined; the endpoint is sparsely documented and returns poor relevance ordering. EuropePMC provides significantly better recall and ranking for preprint search.
- **Separate `biorxiv_get_revisions` tool** → Declined; revision history is included in `biorxiv_get_preprint` output. A separate tool adds surface area without enabling a workflow that `get_preprint` doesn't already cover.
- **Resources exposing preprints by DOI** → Declined; most clients are tool-only, and `biorxiv_get_preprint` already provides the same data. Adding resources would create a second surface with no coverage gain.
- **Prompts for literature review workflows** → Declined; this is a data retrieval server. Prompt templates add maintenance cost without meaningfully improving agent behavior — the tool descriptions carry sufficient operational guidance.
- **Wrapping EuropePMC search behind a facade that hides it as the backend** → Declined in favor of transparency: `biorxiv_search_preprints` is the tool name (user-facing intent), but the Known Limitations section documents that EuropePMC powers it, so maintainers understand the dependency. No implementation detail leaks into tool descriptions.
- **Full-text retrieval via TDM API** → Deferred (not declined permanently). The TDM endpoint requires a separate agreement for bulk access; for targeted agent use, returning the PDF URL and abstract covers the common case. Can be added as `biorxiv_fetch_fulltext` in a future iteration.

### Post-review corrections (API verification)

- **`cursor` type corrected: `string` → `number`** — Live API probe confirms the cursor is a plain integer offset (0, 30, 60, …), not an opaque string token. The `cursor` field in the response envelope also returns as an integer. Removing the `limit` parameter from `biorxiv_list_recent`: the API page size is fixed at 30 regardless of any `limit` param; exposing a `limit` input would create false expectations.
- **Category filtering is server-side, not client-side** — The listing endpoint accepts `?category=neuroscience` as a native query parameter and confirms the active filter in `messages[0].category`. The design erroneously implied client-side filtering. This is a meaningful efficiency win: no need to over-fetch and discard.
- **`/details/{server}/{doi}` returns all revisions in one call** — Confirmed via API probe: a DOI with 3 revisions returns all 3 in `collection[]` from a single call. The Workflow Analysis for `biorxiv_get_preprint` previously implied a per-revision enumeration pattern; that was wrong and has been corrected.
- **`biorxiv_get_published_version` scope narrowed** — `biorxiv_get_preprint` already surfaces the journal DOI in the `published` field. `biorxiv_get_published_version` (using `/pubs/{server}/{doi}`) provides richer crosswalk metadata (journal name, published date, corresponding author institution). Retaining the tool but narrowing its described use case to when the richer crosswalk fields are needed — not as the primary DOI resolution path.
- **`biorxiv_search_preprints`: `category` filter removed** — EuropePMC's preprint search does not support server-side category filtering in the same taxonomy as bioRxiv. Dropped `category` from this tool's inputs to avoid a false client-side filter that would silently degrade to no-op; agents that want category-scoped results should use `biorxiv_list_recent` with `category`.
- **Error contracts added** — No error contracts were declared in the original design. Added a typed error contract table for all five tools covering the domain failure modes an agent should plan around (DOI not found, invalid date range, invalid category, EuropePMC unavailable, crosswalk not found).
