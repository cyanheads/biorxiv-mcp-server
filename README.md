<div align="center">
  <h1>@cyanheads/biorxiv-mcp-server</h1>
  <p><b>Search and retrieve bioRxiv and medRxiv preprints — by DOI, date interval, or keyword — via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/biorxiv-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/biorxiv-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/biorxiv-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

bioRxiv and medRxiv preprint metadata and full text, searchable via EuropePMC. Fetch preprints by DOI, browse by date interval or subject category, search by keyword and author, resolve journal-publication crosswalks, and extract full text from the rendered article page, from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `biorxiv_get_preprint` | Fetch full metadata, abstract, revision history, and journal crosswalk for one or more preprints by DOI |
| `biorxiv_list_recent` | List preprints posted or updated within a date interval, with optional server, category, and funder filters |
| `biorxiv_search_preprints` | Search preprints by keyword and/or author via EuropePMC for relevance ranking, enriched with bioRxiv/medRxiv metadata |
| `biorxiv_get_published_version` | Resolve a preprint DOI to its journal publication record (journal DOI, name, published date) |
| `biorxiv_get_fulltext` | Retrieve a preprint's full text as best-effort Markdown extracted from its rendered HTML article page |
| `biorxiv_list_categories` | List valid subject category strings for bioRxiv and medRxiv |

## Capability reference

### `biorxiv_get_preprint` <sub>tool</sub>

- Takes up to 10 DOIs per call, bare or pasted (`https://doi.org/…`, `doi:…`, a `biorxiv.org`/`medrxiv.org` article URL, a `vN` or `.full` suffix), scoped to `biorxiv`, `medrxiv`, or `both` (default `both`)
- Each preprint returns its full revision history in `revisions[]` — title, authors, abstract, category, license, `awards`, `jatsxmlUrl`, and `publishedJournalDoi` once accepted. Funder names are left out because `api.biorxiv.org` attributes them to unrelated organizations
- A DOI that fails lands in `failed[]` with a `reason` (`not_found`, `invalid_doi_format`, `upstream_unavailable`, `rate_limited`) and a `retryable` flag; `not_found` only when every attempted server answered

---

### `biorxiv_list_recent` <sub>tool</sub>

- Takes a `start_date`/`end_date` interval, `server` (default `both`), and optional `category` (a value from `biorxiv_list_categories`) and bioRxiv-only `funder` (a ROR ID) filters; a filter the API ignored or cannot apply raises `invalid_category` or `invalid_funder` rather than returning an unfiltered or empty page
- Pages of 30 advance with an integer `cursor`; pagination is per server (`{ biorxiv: { cursor, total }, medrxiv: { cursor, total } }`), a cursor past the last page is marked `exhausted: true`, and a server that did not answer is named in `failed[]`
- Abstracts are omitted by default (about three quarters of a page); `include_abstract: true` adds them

---

### `biorxiv_search_preprints` <sub>tool</sub>

- Takes `query` and/or `author`, optional `date_from`/`date_to` and `server` (default `both`); up to 100 results per page (default 25), paged with `cursor_mark`
- EuropePMC ranks the matches (it indexes new preprints within 1–2 days of posting) and the bioRxiv/medRxiv API enriches them with the same fields as `biorxiv_get_preprint`; a record left with EuropePMC metadata only carries `enriched: false` and an `enrichment_error` (`service_error`, `rate_limited`, `not_found`), with `partial_results` set
- Abstracts are included by default; `include_abstract: false` drops them for a response about a third the size

---

### `biorxiv_get_published_version` <sub>tool</sub>

- Takes one preprint DOI and `server` (default `both` — the two servers share their DOI prefixes); `10.64898/` DOIs, which the `/pubs` crosswalk cannot key on, resolve through the preprint's own journal DOI
- Returns journal DOI, journal name, published date, corresponding-author institution, and the `server` that answered; no server answering raises a retryable `upstream_unavailable` or `rate_limited`, never `doi_not_found`

---

### `biorxiv_get_fulltext` <sub>tool</sub>

- Takes a DOI, `server` (default `both`), and an optional `version` (or a `vN` suffix — the two must agree; a version the preprint lacks raises `version_not_found`); extracts Markdown from the rendered HTML article page, since there is no keyless JATS source, and names the answering `server`
- Pages via `offset`/`limit` characters (default 20,000, max 50,000), reporting `totalChars`, `remainingChars`, `hasMore`, and `wordCount`; the extracted article is cached per version, so paging costs one origin fetch
- PDF-only preprints and blocked pages raise `fulltext_unavailable`, routing to `biorxiv_get_preprint`

---

### `biorxiv_list_categories` <sub>tool</sub>

- No API call — a static list of 25 bioRxiv and 51 medRxiv categories, limited to the ones the listing API filters on
- Use it to pick a `category` for `biorxiv_list_recent`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

bioRxiv-specific:

- `BiorxivApiService` wraps `api.biorxiv.org` — details, publications, and crosswalk endpoints with retry and exponential backoff; a 429 is classified as a retryable `rate_limited` error carrying the parsed `Retry-After` wait, with the upstream response body kept out of the payload
- `EuropePmcService` wraps the EuropePMC search endpoint for relevance-ranked keyword and/or author results, classified the same way on a 429
- `BiorxivFullTextService` fetches and extracts Markdown from the rendered HTML article pages on `www.biorxiv.org` / `www.medrxiv.org` — a distinct origin from the JSON API
- Two-server fan-out via `Promise.allSettled` — both `biorxiv` and `medrxiv` queried in parallel when `server="both"`, results merged and deduplicated by DOI
- Polite `User-Agent` header including a mailto address (`BIORXIV_MAILTO` env var) per Cold Spring Harbor Lab API guidelines
- Pairs with **pubmed-mcp-server** (post-publication), **openalex-mcp-server** (citation analytics), and **crossref-mcp-server** (DOI metadata)

Agent-friendly output:

- Graceful partial failure — per-DOI and per-server failures land in `failed[]` with a typed `reason` and `retryable` flag instead of aborting the whole batch or listing call
- Rate-limit transparency — a 429 from any upstream surfaces as `reason: "rate_limited"` carrying the origin's parsed `retryAfter` wait, distinguished from a generic `upstream_unavailable`
- Discriminated enrichment outputs — `biorxiv_search_preprints` results carry `enriched` plus a typed `enrichment_error` (`service_error` / `rate_limited` / `not_found`) so callers branch on data, not string parsing
- Paging and pagination state — `exhausted` cursors are flagged as an out-of-range artifact rather than an empty interval, and `biorxiv_get_fulltext` reports `totalChars` / `remainingChars` / `hasMore` for chunked reads
- Clean titles and abstracts — Highwire export markup is resolved to plain text on both surfaces: symbol placeholders (`{beta}`, `{+/-}`, `[&ge;]`) become their characters, structured-abstract headings read `Results: …`, list items read `• …`, and figure and table blocks are dropped. The Markdown in `content[]` escapes upstream text so it renders as written

## Getting started

### Public Hosted Instance

A public instance is available at `https://biorxiv.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "biorxiv-mcp-server": {
      "type": "streamable-http",
      "url": "https://biorxiv.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "biorxiv-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/biorxiv-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "BIORXIV_MAILTO": "your@email.com"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "biorxiv-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/biorxiv-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "BIORXIV_MAILTO": "your@email.com"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "biorxiv-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "BIORXIV_MAILTO=your@email.com", "ghcr.io/cyanheads/biorxiv-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 BIORXIV_MAILTO=your@email.com bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/biorxiv-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd biorxiv-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optionally set BIORXIV_MAILTO for polite API access
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---|:---|:---|
| `BIORXIV_MAILTO` | Email address included in the `User-Agent` header for polite API access per Cold Spring Harbor Lab guidelines. Optional, but recommended. | — |
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
docker build -t biorxiv-mcp-server .
docker run --rm -e BIORXIV_MAILTO=your@email.com -p 3010:3010 biorxiv-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/biorxiv-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and initializes services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six tools across bioRxiv and medRxiv. |
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
