<div align="center">
  <h1>@cyanheads/biorxiv-mcp-server</h1>
  <p><b>Search and retrieve bioRxiv and medRxiv preprints — by DOI, date interval, or keyword — via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/biorxiv-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/biorxiv-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/biorxiv-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/biorxiv-mcp-server/releases/latest/download/biorxiv-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=biorxiv-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYmlvcnhpdi1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22biorxiv-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fbiorxiv-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://biorxiv.caseyjhand.com/mcp](https://biorxiv.caseyjhand.com/mcp)

</div>

---

## Overview

bioRxiv and medRxiv preprints, metadata and full text. Search by keyword and author, browse a date interval (optionally by subject), fetch any preprint by DOI, and see which preprints went on to journal publication.

### Tools

| Tool | Description |
|:---|:---|
| `biorxiv_get_preprint` | Fetch full metadata, abstract, revision history, and journal crosswalk for one or more preprints by DOI |
| `biorxiv_list_recent` | List preprints posted or updated within a date interval, with optional server, category, and funder filters |
| `biorxiv_search_preprints` | Search preprints by keyword and/or author via EuropePMC for relevance ranking, enriched with bioRxiv/medRxiv metadata |
| `biorxiv_get_published_version` | Resolve a preprint DOI to its journal publication record (journal DOI, name, published date), or a journal article's DOI to the preprint it was posted as |
| `biorxiv_list_published_versions` | List preprints that appeared as journal articles within a journal publication-date interval, whenever they were posted, optionally from one publisher |
| `biorxiv_get_fulltext` | Retrieve a preprint's full text as best-effort Markdown extracted from its rendered HTML article page |
| `biorxiv_list_categories` | List valid subject category strings for bioRxiv and medRxiv |

## Capability reference

### `biorxiv_get_preprint` <sub>tool</sub>

- Takes DOIs bare or pasted (`https://doi.org/…`, `doi:…`, a `biorxiv.org`/`medrxiv.org` article URL, a `vN` or `.full` suffix), scoped to `biorxiv`, `medrxiv`, or `both` (default `both`)
- Accepts up to 200 entries and looks up the first 10 distinct DOIs; the rest come back in `unprocessed[]` to pass in another call. A repeated DOI is looked up once, and every list keeps input order
- Each preprint returns its full revision history in `revisions[]` — title, authors, category, license, `awards`, `jatsxmlUrl`, `publishedJournalDoi` once accepted, and the `server` it was found on (`biorxiv` or `medrxiv`, ready to pass back as `server`). Funder names are omitted because the upstream API misattributes them
- The abstract sits on the latest revision only: the upstream API keeps one abstract per preprint. An earlier revision's own abstract is on its article page, through `biorxiv_get_fulltext` with `version`
- A DOI that fails lands in `failed[]` with a `reason` (`not_found`, `invalid_doi_format`, `upstream_unavailable`, `rate_limited`) and a `retryable` flag; `not_found` only when every attempted server answered

---

### `biorxiv_list_recent` <sub>tool</sub>

- Takes a `start_date`/`end_date` interval, `server` (default `both`), and optional `category` (a value from `biorxiv_list_categories`) and bioRxiv-only `funder` (a ROR ID) filters; a filter that cannot be applied raises `invalid_category` or `invalid_funder`
- Pages of 30 advance with an integer `cursor`, tracked per server (`{ biorxiv: { cursor, total, newPreprints }, medrxiv: { cursor, total, newPreprints } }`); a cursor past the last page is marked `exhausted: true`, and a server that did not answer is named in `failed[]`
- Rows are revisions: `total` counts every version posted in the interval, while `newPreprints` counts the preprints whose first version posted in it, as the API reports it (absent when the API sends no count)
- Abstracts are omitted by default; `include_abstract: true` adds them. Each is the preprint's latest-revision abstract, even on a row for an earlier revision

---

### `biorxiv_search_preprints` <sub>tool</sub>

- Takes `query` and/or `author`, optional `date_from`/`date_to` and `server` (default `both`); up to 100 results per page (default 25; a larger `limit` returns 100 with a notice), paged with `cursor_mark`
- EuropePMC ranks the matches (it indexes new preprints within 1–2 days of posting) and the bioRxiv/medRxiv API enriches them with the same fields as `biorxiv_get_preprint`; a record left with EuropePMC metadata only carries `enriched: false` and an `enrichment_error` (`service_error`, `rate_limited`, `not_found`), with `partial_results` set
- Abstracts are included by default; `include_abstract: false` drops them for a response about a third the size

---

### `biorxiv_get_published_version` <sub>tool</sub>

- Takes one DOI and `server` (default `both`): a preprint DOI (`10.1101/`, `10.64898/`), or a journal article's DOI, which resolves to the preprint it was posted as (`10.1016/j.cell.2020.01.001` → `10.1101/614172`); `10.64898/` DOIs resolve through the preprint's own journal DOI
- Returns the preprint DOI, journal DOI, journal name, published date, corresponding-author institution, and the `server` that answered; if no server answers it raises a retryable `upstream_unavailable` or `rate_limited`, never `doi_not_found`
- Cold Spring Harbor Laboratory Press journal DOIs (`10.1101/gr.…`, `gad.…`, `lm.…`) share the preprint prefix and cannot be resolved by DOI

---

### `biorxiv_list_published_versions` <sub>tool</sub>

- Takes a `start_date`/`end_date` interval of journal publication dates and `server` (default `both`); each row matches the record `biorxiv_get_published_version` returns, and may be a preprint posted years earlier
- Returns `limit` rows per server (default 25, up to the API's 100-row page) from an integer `cursor`, continued at each server's `nextCursor`; a cursor past the last row is marked `exhausted: true`, and a server that did not answer is named in `failed[]`
- Optional `publisher`, a journal DOI prefix (`10.7554` for eLife), lists only the bioRxiv preprints published under it; `server: "both"` queries bioRxiv alone, and `server: "medrxiv"` or a prefix the API does not recognize raises `invalid_publisher`. These rows carry no journal name, authors, or abstract
- Abstracts are omitted by default; `include_abstract: true` adds them

---

### `biorxiv_get_fulltext` <sub>tool</sub>

- Takes a DOI, `server` (default `both`), and an optional `version` (or a `vN` suffix; the two must agree, and a version the preprint lacks raises `version_not_found`); returns Markdown extracted from the rendered HTML article page, naming the answering `server`
- Table cells are not on the page: each table keeps its caption, and `omittedTables` names it with the URL that serves its cells
- Pages via `offset`/`limit` characters (default 20,000), reporting `totalChars`, `remainingChars`, `hasMore`, and `wordCount`; PDF-only preprints and blocked pages raise `fulltext_unavailable`, routing to `biorxiv_get_preprint`

---

### `biorxiv_list_categories` <sub>tool</sub>

- No API call — a static list of 25 bioRxiv and 51 medRxiv categories, limited to the ones the listing API filters on
- Use it to pick a `category` for `biorxiv_list_recent`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

bioRxiv-specific:

- `BiorxivApiService` wraps `api.biorxiv.org` (details, publications, and crosswalk endpoints) and `EuropePmcService` wraps EuropePMC search, both with retry and exponential backoff
- `BiorxivFullTextService` extracts Markdown from the article pages on `www.biorxiv.org` / `www.medrxiv.org`
- Every upstream retry ladder runs on what is left of the tool call's one 50 s budget, so a hung origin ends before a client's 60 s request timeout — in a classified, retryable error, or, when the step that hung is optional, in a result that says what is missing
- Queries `biorxiv` and `medrxiv` in parallel when `server="both"`, each result naming the server that answered; a lookup by DOI stops waiting once the server holding that DOI answers
- Polite `User-Agent` header including a mailto address (`BIORXIV_MAILTO` env var) per Cold Spring Harbor Lab API guidelines
- Pairs with **pubmed-mcp-server** (post-publication), **openalex-mcp-server** (citation analytics), and **crossref-mcp-server** (DOI metadata)

Agent-friendly output:

- Graceful partial failure — per-DOI and per-server failures land in `failed[]` with a typed `reason` and `retryable` flag instead of aborting the call
- Rate-limit transparency — a 429 surfaces as `reason: "rate_limited"` with the parsed `retryAfter` wait, distinct from `upstream_unavailable`
- Typed enrichment status — `biorxiv_search_preprints` results carry `enriched` plus a typed `enrichment_error` (`service_error` / `rate_limited` / `not_found`)
- Clean titles and abstracts — export markup and symbol placeholders (`{beta}`, `[&ge;]`) are resolved to plain text

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http biorxiv-mcp-server https://biorxiv.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add biorxiv-mcp-server -- npx -y @cyanheads/biorxiv-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "biorxiv-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/biorxiv-mcp-server"]
    }
  }
}
```

A contact email in `BIORXIV_MAILTO` (`-e BIORXIV_MAILTO=you@example.com`, or an `env` entry) identifies your requests in the `User-Agent` header, as the Cold Spring Harbor Lab API guidelines ask. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---|:---|:---|
| `BIORXIV_MAILTO` | Email address for the `User-Agent` header; optional but recommended. | — |
| `BIORXIV_API_BASE_URL` | Override the bioRxiv API base URL. | `https://api.biorxiv.org` |
| `EUROPEPMC_API_BASE_URL` | Override the EuropePMC base URL. | `https://www.ebi.ac.uk/europepmc/webservices/rest` |
| `BIORXIV_WEB_BASE_URL` | Override the bioRxiv website base URL (full-text HTML source for `biorxiv_get_fulltext`). | `https://www.biorxiv.org` |
| `MEDRXIV_WEB_BASE_URL` | Override the medRxiv website base URL (full-text HTML source for `biorxiv_get_fulltext`). | `https://www.medrxiv.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/biorxiv-mcp-server.git
  cd biorxiv-mcp-server && bun install
  cp .env.example .env   # optionally set BIORXIV_MAILTO
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -e BIORXIV_MAILTO=your@email.com -p 3010:3010 ghcr.io/cyanheads/biorxiv-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/biorxiv-mcp-server`; the server listens at `http://localhost:3010/mcp`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/biorxiv-mcp-server:latest"]`. To build locally, `docker build -t biorxiv-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and initializes services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools across bioRxiv and medRxiv. |
| `src/services/biorxiv` | `BiorxivApiService` — details, publications, and crosswalk endpoint wrappers with retry. |
| `src/services/biorxiv-fulltext` | `BiorxivFullTextService` — rendered HTML article page fetch and Markdown extraction. |
| `src/services/europe-pmc` | `EuropePmcService` — preprint keyword/author search endpoint wrapper. |
| `tests/` | Unit and integration tests mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
