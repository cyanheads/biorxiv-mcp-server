# biorxiv-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `biorxiv_get_preprint` | Fetch full metadata, abstract, all revision history, JATS XML full-text links, and published-journal DOI for one or more preprints by DOI. Each DOI call returns all revisions in a single response; includes the published journal DOI and journal name when the preprint has been accepted. | `dois: string[]` (1–10, DOI format `10.1101/YYYY.MM.DD.NNNNNN` or `10.64898/…`; doi.org/article URLs, `doi:`, and `vN`/`.full` suffixes stripped); `server?: "biorxiv" \| "medrxiv" \| "both"` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `biorxiv_list_recent` | List preprints posted or updated within a date interval, optionally scoped to one server or subject category. Returns 30 preprints per page (fixed by the API); use `cursor` to step through additional pages. Response includes `total` count for calculating remaining pages. One server failing under `"both"` returns the other's page and names the failure in `failed[]`; every attempted server failing raises a retryable error instead. | `start_date: string` (YYYY-MM-DD); `end_date: string`; `server?: "biorxiv" \| "medrxiv" \| "both"`; `category?: string` (server-side filter, case-insensitive, `_` and `-` read as a space); `cursor?: number` (integer offset, default 0) | `readOnlyHint: true`, `openWorldHint: true` |
| `biorxiv_search_preprints` | Search preprints by keyword and/or author using EuropePMC for relevance ranking, then enrich matching DOIs with the same latest-revision metadata `biorxiv_get_preprint` returns. Covers both servers by default. Surfaces preprints that may not yet have a PubMed record. EuropePMC indexes new preprints within 1–2 days of posting. An enrichment failure degrades that record to EuropePMC-only metadata; a EuropePMC 429 ends the call with a retryable `rate_limited` error. | `query?: string`; `author?: string` (at least one of `query`/`author`; author maps to an EuropePMC `AUTH:` clause); `server?: "biorxiv" \| "medrxiv" \| "both"`; `date_from?: string` (YYYY-MM-DD); `date_to?: string`; `limit?: number`; `cursor_mark?: string` (EuropePMC page token; blank reads as the first page) | `readOnlyHint: true`, `openWorldHint: true` |
| `biorxiv_get_published_version` | Resolve a preprint DOI to its full journal publication record (journal DOI, journal name, published date), or confirm a preprint is not yet published. Use when the preprint's `publishedJournalDoi` field is present and you need richer crosswalk metadata than `biorxiv_get_preprint` provides. Both servers share their DOI prefixes, so `"both"` fans out across them and the output `server` field names the one that answered. `10.64898/` DOIs, which `/pubs` cannot key on, resolve through the journal DOI in the preprint's `/details` record. | `doi: string`; `server?: "biorxiv" \| "medrxiv" \| "both"` (defaults to `both`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `biorxiv_get_fulltext` | Retrieve a preprint's full text as best-effort Markdown, extracted from its rendered HTML article page (`www.{server}.org/content/{doi}v{N}.full`). Reads the latest version, or the one requested by `version` or a `vN` suffix on the DOI, confirmed via the details API — `"both"` fans that resolution across both servers, while the full-text fetch targets the one that answered — then fetches and extracts the body via the framework HTML extractor. Long articles page via offset/limit character chunking, served from a per-version cache. HTML→Markdown, not JATS — section structure is approximate. PDF-only preprints or blocked pages return a typed `fulltext_unavailable` error routing to `biorxiv_get_preprint`; an origin 429 returns a retryable `rate_limited` error. | `doi: string`; `server?: "biorxiv" \| "medrxiv" \| "both"` (defaults to `both`); `version?: number` (default latest); `offset?: number` (default 0); `limit?: number` (max 50000, default 20000) | `readOnlyHint: true`, `openWorldHint: true` |
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
- Category taxonomy is static (hardcoded); 25 bioRxiv and 51 medRxiv categories — the ones the listing endpoint filters on
- DOI is the primary key across all tools
- Pagination via integer cursor (numeric offset) for `biorxiv_list_recent`; offset-based for EuropePMC search results. The listing endpoint returns exactly 30 results per page (fixed by the API; no `limit` parameter is accepted).
- Category filtering on `biorxiv_list_recent` is server-side (query parameter `?category=…`, lowercase with `/` and `_` read as a space), not client-side — the API response's `category` field in the `messages` envelope confirms the active filter, and reads `"all"` when the API ignored it.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `BiorxivApiService` | `api.biorxiv.org` — details, publications, pubs (crosswalk) endpoints | `biorxiv_get_preprint`, `biorxiv_list_recent`, `biorxiv_get_published_version`, `biorxiv_search_preprints` (enrichment), `biorxiv_get_fulltext` (version resolution) |
| `EuropePmcService` | EuropePMC REST API search endpoint — preprint search by keyword and/or author | `biorxiv_search_preprints` |
| `BiorxivFullTextService` | `www.biorxiv.org` / `www.medrxiv.org` — rendered full-text HTML article pages (distinct origin from the JSON API); extracts Markdown via the framework HTML extractor | `biorxiv_get_fulltext` |

**BiorxivApiService resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Wraps full fetch + parse pipeline; uses `withRetry` |
| Backoff | 500ms base (rate-limit unknown; conservative); 3 attempts |
| HTTP errors | `fetchWithTimeout` throws a status-mapped `McpError` on non-2xx (5xx → `ServiceUnavailable`, 429 → `RateLimited`) |
| Rate limiting | HTTP 429 classified as a retryable `rate_limited` error carrying the parsed `Retry-After` seconds; upstream body never propagated |
| Parse failure | Detects HTML error pages, throws transient not `SerializationError` |

**EuropePmcService resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Same `withRetry` wrapper |
| Backoff | 300ms base; EuropePMC recovers quickly from transient errors |
| Field selection | Request `doi,title,authorString,firstPublicationDate,abstractText` only |
| HTTP errors | `fetchWithTimeout` throws a status-mapped `McpError` on non-2xx (5xx → `ServiceUnavailable`, 429 → `RateLimited`) |
| Rate limiting | HTTP 429 classified as a retryable `rate_limited` error carrying the parsed `Retry-After` seconds; upstream body never propagated |
| Parse failure | Detects HTML error pages, throws transient not `SerializationError` |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `BIORXIV_MAILTO` | No | Email address included in the `User-Agent` header (e.g. `your@email.com`). Optional, but recommended for polite API access. |
| `BIORXIV_API_BASE_URL` | No | Override the API base URL. Defaults to `https://api.biorxiv.org`. |
| `EUROPEPMC_API_BASE_URL` | No | Override EuropePMC base URL. Defaults to `https://www.ebi.ac.uk/europepmc/webservices/rest`. |
| `BIORXIV_WEB_BASE_URL` | No | Override the bioRxiv website base URL (full-text HTML source for `biorxiv_get_fulltext`). Defaults to `https://www.biorxiv.org`. |
| `MEDRXIV_WEB_BASE_URL` | No | Override the medRxiv website base URL (full-text HTML source for `biorxiv_get_fulltext`). Defaults to `https://www.medrxiv.org`. |

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with Zod schema for all env vars
2. **BiorxivApiService** — details, publications, and pubs (crosswalk) endpoint wrappers with retry
3. **EuropePmcService** — preprint search endpoint wrapper with retry
4. **`biorxiv_list_categories`** — trivial static-data tool; validates service wiring without a live call
5. **`biorxiv_list_recent`** — date-range listing; exercises BiorxivApiService pagination
6. **`biorxiv_get_preprint`** — batch DOI lookup; exercises revision and details endpoints
7. **`biorxiv_get_published_version`** — crosswalk endpoint; fans out across both servers by default
8. **`biorxiv_search_preprints`** — fan-out: EuropePMC search → DOI list → BiorxivApiService enrichment
9. **BiorxivFullTextService** — article-page HTML fetch and Markdown extraction, cached per version; a second origin from the JSON API
10. **`biorxiv_get_fulltext`** — version resolution via BiorxivApiService, then full-text extraction with offset/limit chunking

Each step is independently testable against the live API.

---

## Domain Mapping

| Noun | Operations | API Endpoint | Notes |
|:-----|:-----------|:-------------|:------|
| Preprint (details) | get by DOI (all revisions) | `/details/{server}/{doi}` | Returns all revisions in `collection[]` in a single call. Fields: `title`, `authors`, `author_corresponding`, `author_corresponding_institution`, `doi`, `date`, `version`, `type`, `license`, `category`, `jatsxml`, `abstract`, `funder`, `published` (journal DOI or `"NA"`), `server`. |
| Preprint (listing) | list by date interval | `/details/{server}/{start}/{end}/{cursor}` | `cursor` is an integer offset (0, 30, 60, …). Always returns exactly 30 results per page. Response `messages[0]` includes `total`, `count_new_papers`, and the active `category` filter value (`"all"` when unfiltered; absent on an empty page). Category is passed as a query parameter in the API's spelling: `?category=hiv%20aids` — a slash, raw or percent-encoded, is ignored. |
| Published version (crosswalk) | resolve preprint→journal | `/pubs/{server}/{doi}` | Returns `preprint_doi`, `published_doi`, `published_journal`, `published_date`, `preprint_title`, `preprint_authors`, `preprint_category`, `preprint_date`, `preprint_abstract`, `preprint_author_corresponding`, `preprint_author_corresponding_institution`. Richer than the `published` field in details. Never parses a `10.64898/` preprint DOI (empty collection, status `no articles found for published version of `); keyed by the journal DOI instead it resolves those. The key is read as its first two `/`-separated segments and a single-encoded `%2F` is a 404, so a journal DOI with a second slash (`10.1093/genetics/…`) sends every slash after the first as `%252F`, which the API decodes back to `/`. |
| Categories | list | Hardcoded taxonomy (static) | No API endpoint; static list maintained in code. |
| EuropePMC search | full-text search returning DOIs | `GET /search?query=…&resulttype=lite&filter=preprint` | Returns ranked DOIs used to drive enrichment via details endpoint. |

The bioRxiv API uses `{server}` as either `biorxiv` or `medrxiv`; no multi-server single call exists. Fan-out to both servers happens in the service layer via `Promise.all`, results merged and deduplicated by DOI.

**`biorxiv_list_recent` pagination with `server="both"`:** when fanning out across both servers, each server has its own independent `total` and `cursor`. The response must surface per-server pagination state (e.g., `{ biorxiv: { cursor: 30, total: 550 }, medrxiv: { cursor: 30, total: 210 } }`) so callers know how to advance each server's cursor independently. A single merged `cursor` number is ambiguous and wrong here.

Because the two servers hold different result counts for the same interval, one cursor can be valid for one server and past the end for the other. The API answers an out-of-range cursor with an empty collection and `total: 0`, which would otherwise read as "this server has nothing in the interval". Each per-server entry therefore carries an `exhausted` flag (`true` when zero records came back at a non-zero cursor); `total` stays present and required, and a `notice` names the exhausted server when the other still returned records.

A server that never answered is the other half of that problem and is kept distinct from it. It has no cursor and no total, so it gets no `pagination` entry at all — and an omitted entry is invisible, leaving a partial result indistinguishable from a complete one. It is therefore reported in a top-level `failed[]` (`{ server, error }`), rendered as its own line in the per-server summary, and named in the `notice`. `exhausted` stays reserved for a server that answered; `failed[]` for one that did not. The call still returns the surviving server's page — a partial result beats none, provided the caller is told it is partial and at least one server answered. Because `ctx.enrich.notice` is last-wins, every qualification that applies (failed servers, exhausted cursors, zero results) is composed into a single notice string with the partial-result sentence first, since it changes how every other number in the response reads.

When *no* attempted server answered there is nothing left to qualify, and the call raises a retryable error instead of returning a page. "Nothing found here" is a claim about what the servers reported and none of them reported, so an empty success would be indistinguishable from an interval that genuinely holds nothing — for any caller that branches on success-vs-error rather than reading prose. This is the same rule `biorxiv_get_preprint` applies to a DOI whose every server failed, and `failed[]` therefore never holds the full server set.

---

## Workflow Analysis

### `biorxiv_search_preprints` (fan-out workflow)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `EuropePmcService.search(query, filter=preprint)` | Ranked DOI list with titles |
| 2a | `BiorxivApiService.getDetails(doi, "biorxiv")` ×N | Enrich matching DOIs on bioRxiv — one call per DOI returns all revisions |
| 2b | `BiorxivApiService.getDetails(doi, "medrxiv")` ×N | Enrich matching DOIs on medRxiv (only when `server=both` and DOI source is ambiguous) |
| — | Merge by DOI, surface `server` field on each result | Deduplication |

Steps 2a/2b run in parallel via `Promise.allSettled`; enrichment failures degrade to EuropePMC-only metadata for that record, surfaced in a `partial_results` flag. EuropePMC's `doi` field identifies the server; when it's known (e.g., `10.1101/` prefix = bioRxiv), skip the parallel medRxiv call. Step 1 has no such fallback — a failure there ends the call, as `search_unavailable` or, for an origin 429, `rate_limited`.

### `biorxiv_get_preprint` (batch lookup)

`/details/{server}/{doi}` returns **all revisions** in a single `collection[]` response. No revision enumeration loop is needed.

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `BiorxivApiService.getDetails(doi, server)` for each DOI × each server | One call per (DOI, server) pair; each call returns all revisions for that preprint |
| — | Merge per-DOI results; surface `server` field; report per-DOI failures in `failed[]` | Partial success |

When `server="both"`, each DOI generates two calls (biorxiv + medrxiv) run in parallel via `Promise.allSettled`. When `server` is specified, one call per DOI. Partial success reported per-DOI in `failed[]`. Note: if a DOI exists only on bioRxiv, the medrxiv call returns an empty collection (not an error) — this is not a failure.

"Not found" is a claim about what the servers reported, so it requires every attempted server to have answered. A DOI whose lookup failed on any server it needed is classified `upstream_unavailable` (retryable), not `not_found` — on the per-DOI `failed[]` entry and, when nothing in the batch resolved, on the thrown error. The same rule governs the single-server path, where one failed call leaves absence equally unestablished.

---

## Error Contracts

| Tool | Reason | Code | When | Retryable? |
|:-----|:-------|:-----|:-----|:-----------|
| `biorxiv_get_preprint` | `doi_not_found` | `NotFound` | Every requested DOI resolves to an empty collection and every requested server answered | No — verify the DOI (`10.1101/…` or `10.64898/…`) |
| `biorxiv_get_preprint` | `invalid_doi_format` | `ValidationError` | Every input DOI fails the `10.\d{4,}/` pattern even after URL, `doi:`, and suffix stripping | No — fix and retry |
| `biorxiv_get_preprint` | `upstream_unavailable` | `ServiceUnavailable` | No DOI resolved and at least one lookup failed, so absence was never established | Yes — retry after a delay |
| `biorxiv_get_preprint` | `rate_limited` | `RateLimited` | No DOI resolved and at least one lookup was rejected 429 by `api.biorxiv.org` | Yes — wait the `retryAfter` seconds |
| `biorxiv_list_recent` | `invalid_date_range` | `ValidationError` | `end_date` is before `start_date`, or either date is malformed | No — fix and retry |
| `biorxiv_list_recent` | `invalid_category` | `ValidationError` | Category not in the requested server's taxonomy, or every server that answered ignored it (echoed `category: "all"` with its unfiltered listing) | No — use `biorxiv_list_categories` to get valid values, or omit the category |
| `biorxiv_list_recent` | `upstream_unavailable` | `ServiceUnavailable` | Every attempted server failed, so no page came back and an empty interval was never established | Yes — retry after a delay |
| `biorxiv_list_recent` | `rate_limited` | `RateLimited` | Every attempted server failed and at least one was rejected 429 by `api.biorxiv.org` | Yes — wait the `retryAfter` seconds |
| `biorxiv_search_preprints` | `invalid_date_range` | `ValidationError` | `date_from` or `date_to` is malformed or not a real calendar date, or `date_from` is after `date_to` | No — fix and retry |
| `biorxiv_search_preprints` | `search_unavailable` | `ServiceUnavailable` | EuropePMC search endpoint is unreachable, returns 5xx, or answers a first-page search without a result list on every retry | Yes — retry after delay |
| `biorxiv_search_preprints` | `invalid_cursor_mark` | `ValidationError` | EuropePMC answers a `cursor_mark` page without a result list on every retry — the token is malformed or not one it issued | No — pass the prior page's `nextCursorMark` exactly, or restart from `*` |
| `biorxiv_search_preprints` | `rate_limited` | `RateLimited` | The EuropePMC search endpoint rejected the keyword search with HTTP 429 | Yes — wait the `retryAfter` seconds; the recovery hint offers `biorxiv_list_recent`, on an origin this limit does not cover |
| `biorxiv_get_published_version` | `invalid_doi_format` | `ValidationError` | Input DOI does not match the `10.NNNN/` pattern | No — fix and retry |
| `biorxiv_get_published_version` | `doi_not_found` | `NotFound` | The crosswalk is empty on every attempted server and the preprint's `/details` record lists no journal version (`published: "NA"`), or no server holds the preprint | No — retry with `server="both"` if scoped to one, or confirm the DOI with `biorxiv_get_preprint` |
| `biorxiv_get_published_version` | `upstream_unavailable` | `ServiceUnavailable` | No published record was established and at least one crosswalk or `/details` lookup failed | Yes — retry after a delay |
| `biorxiv_get_published_version` | `rate_limited` | `RateLimited` | No published record was established and at least one crosswalk or `/details` lookup was rejected 429 by `api.biorxiv.org` | Yes — wait the `retryAfter` seconds |
| `biorxiv_get_fulltext` | `invalid_doi_format` | `ValidationError` | Input DOI does not match `10.NNNN/` pattern | No — fix and retry |
| `biorxiv_get_fulltext` | `version_conflict` | `ValidationError` | The DOI's `vN` suffix and the `version` input name different versions | No — name the version once, or make the two agree |
| `biorxiv_get_fulltext` | `doi_not_found` | `NotFound` | DOI resolves to an empty collection on every attempted server | No — retry with `server="both"` if scoped to one, or find the DOI via `biorxiv_search_preprints` |
| `biorxiv_get_fulltext` | `version_not_found` | `NotFound` | The preprint has no revision with the requested version; the error lists the available ones | No — request a listed version, or omit it for the latest |
| `biorxiv_get_fulltext` | `upstream_unavailable` | `ServiceUnavailable` | No attempted server resolved the DOI and at least one lookup failed | Yes — retry after a delay |
| `biorxiv_get_fulltext` | `rate_limited` | `RateLimited` | Either origin returned HTTP 429 — the article page during the full-text fetch, or `api.biorxiv.org` during version resolution | Yes — wait the `retryAfter` seconds; the recovery hint names the limited origin |
| `biorxiv_get_fulltext` | `fulltext_unavailable` | `NotFound` | Preprint exists but its full-text HTML page is blocked, missing, or yields no extractable text (PDF-only) | No — use `biorxiv_get_preprint` for title, abstract, and metadata |
| `biorxiv_get_fulltext` | `offset_out_of_range` | `ValidationError` | `offset` ≥ total character length of the extracted text | No — use a smaller offset (`remainingChars` shows what is left) |
| All | _(baseline)_ | `ServiceUnavailable` | `api.biorxiv.org` (or the full-text origin) is unreachable or returns 5xx | Yes |

`biorxiv_search_preprints`' `rate_limited` entry covers the EuropePMC search call only. Its enrichment calls reach `BiorxivApiService` and can be rate-limited too, but every enrichment failure degrades to EuropePMC-only metadata rather than failing the search; a 429 there is labelled apart as `enrichment_error: 'rate_limited'` on the affected record, so a caller can tell "wait, then retry" from "this DOI is not on that server" without raising a tool error.

---

## Known Limitations

- **bioRxiv native search is not used** — the `/search` endpoint is weak and undocumented. EuropePMC provides relevance-ranked results but may lag new preprints by 1–2 days.
- **Full-text via HTML extraction (best-effort, not JATS)** — `biorxiv_get_fulltext` retrieves full text by fetching the rendered HTML article page (`www.{server}.org/content/{doi}v{N}.full`) and extracting Markdown via the framework HTML extractor. There is no keyless JATS source: the `.full.xml` suffix falls back to HTML, and JATS proper is S3-TDM/requester-pays only. Section structure is therefore approximate, not structured JATS. Coverage is partial — some preprints are PDF-only (empty extraction) and some origins may block programmatic access (Cloudflare); both surface as a typed `fulltext_unavailable` error routing to `biorxiv_get_preprint`, while an origin rate limit (429) surfaces as a retryable `rate_limited` error. Long articles page via offset/limit character chunking.
- **Listing page size is fixed at 30** — the API does not accept a `limit` parameter; pagination requires stepping by cursor offset (0, 30, 60, …). The `total` field in the response lets clients calculate total pages.
- **Category filter on listing is server-side** — the API filters by category, but answers a category it does not recognize with its unfiltered listing and a `messages[0].category` of `"all"`, never an error. The taxonomy is validated before the call, and the echo is checked after it: a leg whose filter was ignored is dropped with a notice, and a call left with no filtered page raises `invalid_category`.
- **No multi-server batch endpoint** — the API requires separate calls per server; the service layer fans out via `Promise.all`.
- **Rate limits undocumented, and every origin enforces one** — neither `api.biorxiv.org`, the `www.{server}.org` article pages, nor EuropePMC publishes a quota, and all three answer HTTP 429 once tripped. The article pages sit behind a Cloudflare edge that starts limiting after a handful of consecutive fetches. A `Retry-After` is read when the response carries one, and every hint falls back to generic wording when it does not. Each is classified as a retryable `rate_limited` error carrying the parsed wait — `BiorxivFullTextService` for the article pages, `BiorxivApiService` for the JSON API, `EuropePmcService` for search — and `biorxiv_get_fulltext`'s per-version extraction cache removes the repeat article-page fetches that provoked its side. `withRetry` honors `Retry-After` and fails fast when the requested wait exceeds its 30s cap, so no local backoff layer belongs here.
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

### Full-text retrieval — now implemented (`biorxiv_get_fulltext`)

Previously deferred (see the "Deferred" notes above); implemented after an API design pass.

- **Source: rendered HTML page, not JATS.** Verified there is no keyless JATS source — `…v{N}.full.xml` falls back to HTML, and JATS proper is S3-TDM/requester-pays only. So the tool fetches the `.full` HTML page and extracts Markdown via the framework `htmlExtractor` (`defuddle` + `linkedom`, added as direct deps). Honest `contentFormat: 'html-markdown'` label plus a best-effort caveat; section structure is not guaranteed.
- **Content selector `.fulltext-view`.** bioRxiv/medRxiv render on the Highwire platform; defuddle's auto-detection latches onto the reference apparatus and misses the body (~383 words vs ~10,197 for one probed article). Passing the `.fulltext-view` selector captures the full text; defuddle falls back to auto-detection when the selector misses, so it is always safe to pass.
- **Distinct fetch path from the JSON API.** The full-text fetch EXPECTS `text/html`, so it does not route through `BiorxivApiService`'s "HTML response = upstream error" guard. It lives in a separate `BiorxivFullTextService` with its own per-server web-host config (`BIORXIV_WEB_BASE_URL` / `MEDRXIV_WEB_BASE_URL`).
- **Coverage handled as typed errors, not crashes.** PDF-only preprints (empty extraction), Cloudflare block/challenge pages, and 403/404 responses map to one `fulltext_unavailable` reason routing to `biorxiv_get_preprint`; transient 5xx/timeouts bubble as `ServiceUnavailable`. Challenge/interstitial pages are detected and never fed to the extractor.
- **Chunking mirrors `gutenberg_get_text`.** offset/limit character chunking with `totalChars`/`remainingChars`/`hasMore` disclosure so long articles are fully readable across calls.
- **Extracted articles cached in `ctx.state` under `fulltext/v2/{server}/{doi}/{version}`, TTL one hour.** Paging previously cost a full origin fetch plus a full Defuddle extraction per chunk, which is what tripped the origin's rate limiter partway through long articles. The key is slash-delimited because the storage layer validates keys against `[a-zA-Z0-9_.\-/]` and rejects a colon separator outright. The cache is tenant-scoped (`ctx.state`), never process-wide, and only `kind: 'article'` results are written — a blocked, rate-limited, or empty page must be able to recover on a later call. It is an optimization and never a dependency: a storage backend that refuses the read or the write degrades to an origin fetch rather than failing the request, and a tenant-less caller (HTTP + JWT with no `tid` claim) runs uncached. TTL is a constant rather than an env var: nothing has asked to tune it, and a knob would need declaring across `.env.example`, `server.json`, `manifest.json`, and the README.
- **HTTP 429 classified as its own `rate_limited` reason.** 429 does not belong in `DETERMINISTIC_UNAVAILABLE_STATUSES` — that set means "a re-fetch will never succeed", and a rate limit is the opposite. The retry side is already handled by the framework: `withRetry` honors `data.retryAfter` and fails fast when the requested wait exceeds `maxDelayMs` (30s), so no local backoff logic is needed. What the tool adds is a typed retryable reason carrying the parsed `Retry-After` and a recovery hint naming `biorxiv_get_preprint`. The error payload carries only the parsed wait — the origin's block-page HTML (`data.body` / `data.responseBody`) is deliberately not propagated.
- **DOI resolution defaults to `server="both"`.** Both servers issue `10.1101/` DOIs, so a caller holding a bare DOI cannot tell which value to pass and a medRxiv preprint missed at the `biorxiv` default. Resolution fans out via `Promise.allSettled` with first-fulfilled-non-empty in array order (bioRxiv first); the full-text fetch stays single-server against the one that answered, and the output `server` field keeps its two-value enum. An all-rejected fan-out raises the retryable `upstream_unavailable` rather than collapsing into `doi_not_found`.
- **`biorxiv_get_usage` descoped.** The same design pass proposed a per-preprint usage/metrics tool; bioRxiv's `/usage/{m|y}/{cursor}` endpoint returns corpus-wide aggregate stats, not per-preprint counts, so it cannot back that tool. Not built.

### `author` filter on `biorxiv_search_preprints`

- **Author maps to an EuropePMC `AUTH:"…"` field query,** ANDed with the keyword query in `EuropePmcService`. `query` was relaxed to optional with a schema refine requiring at least one of `query`/`author`, so author-only search is valid and existing query-only calls stay valid. Embedded double-quotes are stripped from the author value so a stray quote cannot break the AUTH phrase.

### Rate limiting on the JSON API, and total-failure classification

- **`BiorxivApiService` classifies HTTP 429 the same way `BiorxivFullTextService` does.** The JSON API origin rate-limits too, and previously a 429 reached the caller as a bare `RateLimited` with no `reason`, no recovery hint, and — because `fetchWithTimeout` attaches it — the upstream response body. The service now rebuilds the payload from scratch: `{ reason: 'rate_limited', retryable: true, retryAfter?, recovery }` and nothing else. The full-text service's `kind: 'unavailable'` result shape was deliberately *not* mirrored here: that shape exists because a blocked article page has a graceful-degradation branch to route to, and the metadata path has no partial preprint to fall back on, so throwing is the honest outcome. No retry logic was added — `withRetry` already honors `Retry-After` and fails fast past its cap, so classification and payload hygiene were the whole gap.
- **`parseRetryAfterSeconds` moved to `services/shared.ts`.** Both fetch paths read the same header in the same two RFC 9110 forms; a second copy would be a second thing to get wrong. It joins `detectHtmlError` and `normalizeUpstreamText`, alongside a new `findRateLimit`, which reduces a set of rejections to the wait a caller should honor — the *longest* of the reported ones, since a shorter wait would still land inside whichever origin asked for the longer one.
- **A rate limit outranks a generic upstream failure wherever both can contribute.** When a tool's every-attempt-failed branch mixes a 429 with an unrelated outage, it raises `rate_limited` rather than `upstream_unavailable`. Both tell the caller to retry, but only one says when, and retrying sooner than the origin asked would land straight back inside the same limit — so the more specific reason is also the safer one. The generic reason stays for the case where no 429 was involved at all.
- **`biorxiv_get_fulltext` keeps one `rate_limited` reason for two origins.** Its version resolution hits `api.biorxiv.org` while its full-text fetch hits the article page, and either can 429. A second reason was rejected: from the caller's seat both mean "wait the stated interval, then retry", so the branch would have no distinct action behind it. What genuinely differs is the fallback advice — `biorxiv_get_preprint` shares the metadata origin, so recommending it while *that* origin is the limited one sends the caller back into the limit. The recovery hint therefore names the limiting origins and adapts the fallback, and the two payloads stay structurally distinct anyway (`sourceUrl` on the article-page case, `servers` on the resolution case). Both can be limiting at once: under `server="both"` one server answering resolution says nothing about whether the metadata origin let the other one through, so an article-page limit re-reads the resolution rejections before claiming the fallback still works, and the reported wait is the longer of the two — a retry re-runs resolution as well as the fetch.
- **`biorxiv_list_recent` raises on total failure instead of returning an empty page.** One server failing under `server="both"` still returns the other's page — that is the partial-result case and it is unchanged. Every attempted server failing is a different condition: the tool used to return a successful empty listing with a notice explaining that nothing answered, which a caller branching on success-vs-error could not tell from an empty date interval without parsing prose. It now raises the retryable `upstream_unavailable` (or `rate_limited`) that `biorxiv_get_preprint` already raised for the equivalent DOI case, which also makes `failed[]` structurally incapable of holding every attempted server.
- **`biorxiv_search_preprints` enrichment carries every latest-revision field.** `type`, `license`, `funder`, and `authorCorrespondingInstitution` were absent from the enriched projection, so the same DOI described less through search than through `biorxiv_get_preprint` even when the upstream record carried all four. They now ride the enriched branch, the output schema, and `format()` — the last of those is what keeps `content[]`-only clients level with `structuredContent` ones. Full revision *history* stays out of search: `revisionCount` plus `biorxiv_get_preprint` remains the detailed-history workflow.
- **An enrichment 429 degrades rather than failing the search; a search 429 raises.** The split follows what each path has to fall back on. Every enrichment failure falls back to EuropePMC metadata, and a rate limit is no more fatal there than a 5xx, so it only gets its own `enrichment_error: 'rate_limited'` value — enough for a caller to tell "wait, then retry" from "this DOI is not indexed on the target server". The EuropePMC search is the tool's primary call and has nothing to degrade to, so a 429 there raises the `rate_limited` contract entry. The two live in separate `catch` blocks — the search's own `try` and the per-DOI enrichment `try` inside the result map — so neither branch can capture the other's rejections.
- **`EuropePmcService` classifies HTTP 429 the way `BiorxivApiService` does.** Both throw; `BiorxivFullTextService` recognises a 429 too but returns a `kind: 'unavailable'` result, because its article-page fetch has a degrade path neither of the other two has. Before this, a EuropePMC rate limit reached `biorxiv_search_preprints` as `search_unavailable` — the reason declared for "unreachable or a server error", which a 429 is neither — and the origin's `Retry-After` was dropped on the way out, so a caller was told to retry "after a short delay" when the origin had named a wait. The service now rebuilds the payload from scratch: `{ reason: 'rate_limited', retryable: true, retryAfter?, recovery }` and nothing else, so the upstream response body `fetchWithTimeout` attaches never crosses into it. No retry logic was added — `withRetry` already honors `Retry-After` and fails fast past its cap.
- **The search rate-limit hint routes to `biorxiv_list_recent`, and says only that the limit does not cover it.** EuropePMC is the only origin `biorxiv_search_preprints` reaches for search, and naming that origin's own endpoint as the fallback would send the caller straight back into the limit. `biorxiv_list_recent` reads `api.biorxiv.org`, which an EuropePMC limit does not extend to — but the search is step 1, so nothing in the call establishes whether that origin is answering, and `api.biorxiv.org` rate-limits independently. The hint therefore states the scope of the limit and offers the listing to try, never that it will answer. Compare `biorxiv_get_fulltext`, which does have resolution rejections to read and so can claim the metadata origin still works.

### EuropePMC empty-body responses, and `wordCount` from the served text

- **A 200 body with no `resultList` is retried, never read as zero matches.** EuropePMC sometimes answers with only `{"version":"6.9"}`: about one request in five for a valid first page, about one in eight for a valid cursor page, and every time for a malformed `cursorMark`. A genuine zero-hit answer still carries an empty `resultList`, so a missing one is unambiguous. `EuropePmcService` throws it as a transient `ServiceUnavailable` inside `withRetry`, so the intermittent case clears transparently (four attempts).
- **A cursor past the last match is the end of the list, not a failed search.** EuropePMC still returns a `nextCursorMark` on the page holding the last match, and the page after it comes back with an empty `resultList` and the query's real `hitCount`. With a supplied cursor and a non-zero `hitCount`, the notice says every match was on earlier pages rather than suggesting broader search terms.
- **A persisting empty body is split by what the caller supplied.** With a `cursor_mark` other than `*`, it raises `invalid_cursor_mark`, a `ValidationError` whose hint says to reuse the prior page's `nextCursorMark` or restart from `*`. On a first page it raises `search_unavailable`, whose hint does not mention `*`, because the request already started there. The cursor branch spends the full retry budget: a valid cursor draws the empty body intermittently too, so a shorter ladder would mislabel it as invalid. A malformed cursor costs four requests plus about two seconds of backoff before the error.
- **The service writes the empty-body error messages itself.** `withRetry` appends `(failed after N attempts)` to an exhausted error. The service rebuilds both errors with their own wording and puts the count in `data.retryAttempts`. The tool branches on `data.reason`, never on message text.
- **`biorxiv_get_fulltext` counts `wordCount` from the Markdown it pages over.** defuddle's `wordCount` counts the text nodes of its intermediate HTML, before Markdown serialization. It never sees heading and list markers, link targets, or image alt text, so it is not a measure of `content`. The tool now counts whitespace-delimited tokens of the same string `totalChars` measures, and the field is always present. The service no longer carries a word count, and the cache key moved to `fulltext/v2` so entries holding the extractor's figure are never read back.

### Category spelling, the `10.64898/` crosswalk, and DOI input forms

- **Categories are sent in the API's spelling: lowercase, `/` and `_` read as a space.** A live sweep of every taxonomy entry found `HIV/AIDS` ignored in any form containing a slash (raw or `%2F`) and filtered as `hiv aids`. The same spelling is what every record's `category` field carries, so it doubles as the input match key: `Cell Biology`, `cell biology`, and `cell_biology` are one filter, and a category copied off a result works as input. `-` is read as a space in input too, so the websites' collection slugs (`cell-biology`, `hiv-aids`) match; no category name contains a hyphen.
- **Three taxonomy entries removed rather than special-cased.** bioRxiv `Epidemiology` and `Clinical Trials` and medRxiv `Vascular Medicine` are ignored by the API in every spelling tried, answering with the unfiltered listing. Advertising them as filters would return unrelated preprints under a filtered-looking request. `Epidemiology` stays medRxiv-only, so under `server="both"` it routes to medRxiv alone.
- **An ignored filter is checked on every response, not only at the taxonomy.** When a category was sent and `messages[0].category` echoes `"all"`, that leg's page is unfiltered. A single-leg call raises `invalid_category`; a `server="both"` fan-out drops the leg with a notice and fails only when no leg applied the filter. The leg is not added to `failed[]`: it answered, and retrying will not change the answer. When one leg failed and the other ignored the filter, the retryable upstream error wins, because the failed leg may still return a filtered page. An empty page carries no category echo, so it never trips the check.
- **`biorxiv_get_published_version` falls back to `/details`, then queries `/pubs` by journal DOI.** `/pubs/{server}/{doi}` never parses a `10.64898/` DOI. The preprint's `/details` record names its journal DOI, and `/pubs` keyed by that journal DOI returns the full crosswalk record, including journal name and date. The API reads only the first two `/`-separated segments of the key and answers a single-encoded `%2F` with a 404, but decodes the key once more itself, so a journal DOI with a second slash (`10.1093/genetics/…`, every Oxford University Press journal) has each slash after the first sent as `%252F` and resolves too — sent raw, those DOIs found nothing. When the reverse lookup still finds nothing, or fails, the journal DOI is returned alone with a notice, and `publishedJournal`/`publishedDate` stay absent rather than being inferred. Measured across 16 `10.64898/` DOIs: forward lookup 0/16, reverse lookup 14/16 with raw slashes, and both misses were multi-slash journal DOIs, the shape the double-encoded key resolves (checked live on four `10.1093/` journal DOIs). A crosswalk hit on the first lookup returns immediately, so the `10.1101/` path makes no extra calls.
- **One DOI normalizer for the three DOI-keyed tools.** `normalizeDoi` in `services/shared.ts` strips a `doi.org`/`dx.doi.org` URL, a `doi:` label, a `{www.}{biorxiv,medrxiv}.org/content/` URL (with its query and fragment), and a trailing `vN` plus any article-tab suffix (`.full`, `.full.pdf`, `.article-metrics`, `.supplementary-material`, …, matched case-insensitively), then requires `10.` + a 4+-digit registrant + `/` + a non-empty suffix. The suffix match is anchored after a digit, so it only ever removes text around a bioRxiv/medRxiv identifier. A bare DOI that passed the old prefix check passes through unchanged. Results report the bare DOI; an unparseable entry is reported as sent.
- **`biorxiv_get_fulltext` takes a `version` input and honors a `vN` suffix; when both are given they must agree.** A pasted article URL names a version, and the versioned page is independently fetchable. Disagreement raises `version_conflict` before any API call, because picking either one would silently return text the caller did not ask for. A version the preprint lacks raises `version_not_found` listing the available ones. The next-chunk prompt carries `version=` so paging a non-latest version stays on it.
