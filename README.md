<div align="center">
  <h1>@cyanheads/biorxiv-mcp-server</h1>
  <p><b>Search and retrieve bioRxiv and medRxiv preprints — by DOI, date interval, or keyword — via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/biorxiv-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/biorxiv-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/biorxiv-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/biorxiv-mcp-server/releases/latest/download/biorxiv-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=biorxiv-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYmlvcnhpdi1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22biorxiv-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/biorxiv-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Six tools for working with bioRxiv and medRxiv preprint data:

| Tool | Description |
|:---|:---|
| `biorxiv_get_preprint` | Fetch full metadata, abstract, revision history, and journal crosswalk for one or more preprints by DOI |
| `biorxiv_list_recent` | List preprints posted or updated within a date interval, with optional server and category filters |
| `biorxiv_search_preprints` | Search preprints by keyword and/or author via EuropePMC for relevance ranking, enriched with bioRxiv/medRxiv metadata |
| `biorxiv_get_published_version` | Resolve a preprint DOI to its journal publication record (journal DOI, name, published date) |
| `biorxiv_get_fulltext` | Retrieve a preprint's full text as best-effort Markdown extracted from its rendered HTML article page |
| `biorxiv_list_categories` | List valid subject category strings for bioRxiv and medRxiv |

### `biorxiv_get_preprint`

Fetch preprint metadata by DOI — all revisions in one call.

- Batch fetch up to 10 DOIs in a single request
- Each DOI returns the full revision history in `collection[]` — one API call per DOI, no enumeration loop
- Includes title, authors, abstract, category, license, JATS XML full-text link (`jatsxml`), and published journal DOI when the preprint has been accepted
- Scope to `biorxiv`, `medrxiv`, or `both`; when `both`, each DOI fans out in parallel and partial failures report per-DOI in `failed[]`
- Each `failed[]` entry carries a `reason` (`not_found`, `invalid_doi_format`, `upstream_unavailable`, `rate_limited`) and a `retryable` flag — a DOI is only reported as not found when every attempted server answered
- A lookup the origin rate-limited (HTTP 429) reports as `rate_limited` rather than folding into `upstream_unavailable`, and carries `retryAfter` — the wait in seconds `api.biorxiv.org` asked for

---

### `biorxiv_list_recent`

Page through preprints in a date interval.

- Server-side category filtering via `?category=…` — pass a value from `biorxiv_list_categories`
- Fixed page size of 30 (API constraint); advance with integer `cursor` (0, 30, 60, …)
- Response includes `total` count per server for calculating remaining pages
- When `server="both"`, each server paginates independently; response surfaces per-server pagination state (`{ biorxiv: { cursor, total }, medrxiv: { cursor, total } }`)
- A server whose cursor is past its last page is marked `exhausted: true` — the API reports `total: 0` for an out-of-range cursor, so that count is an artifact rather than the interval total
- One server not answering under `server="both"` is named in `failed[]` rather than dropped; the other server's page is still returned, and a non-empty `failed[]` marks the result set as partial
- Every attempted server failing raises a retryable `upstream_unavailable` (or `rate_limited`) error instead of returning an empty page — nothing answered, so an empty interval was never established

---

### `biorxiv_search_preprints`

Keyword and/or author search with relevance ranking.

- EuropePMC powers relevance ranking (indexes new preprints within 1–2 days of posting); bioRxiv/medRxiv API provides canonical metadata enrichment
- Optional `author` maps to an EuropePMC `AUTH:"…"` field query, ANDed with the keyword query — supply `query`, `author`, or both
- Covers both servers by default; scope down with `server`
- Optional date range filters (`date_from`, `date_to`)
- Enriched results carry the same latest-revision fields `biorxiv_get_preprint` returns — including `type`, `license`, `funder`, and `authorCorrespondingInstitution`
- Enrichment failures degrade gracefully to EuropePMC-only metadata, surfaced via `partial_results` and a per-record `enrichment_error` (`service_error`, `rate_limited`, or `not_found`)
- A EuropePMC rate limit (HTTP 429) raises a retryable `rate_limited` error carrying the origin's `Retry-After` wait — the search is the primary call and has no metadata to fall back on, unlike the enrichment step

---

### `biorxiv_get_published_version`

Resolve a preprint DOI to its journal publication crosswalk.

- Uses the `/pubs/{server}/{doi}` endpoint for richer metadata than the `publishedJournalDoi` field in `biorxiv_get_preprint`
- Returns journal DOI, journal name, published date, and corresponding author institution
- Use when the preprint's `publishedJournalDoi` field is present and you need the full crosswalk record
- Scope to `biorxiv`, `medrxiv`, or `both`; `both` is the default because the two servers share the `10.1101/` DOI prefix, and the output `server` field names the one that answered
- No server answering raises a retryable `upstream_unavailable`, or `rate_limited` with the origin's wait when the failure was an HTTP 429 — never `doi_not_found`, which would assert an absence nothing established

---

### `biorxiv_get_fulltext`

Retrieve a preprint's full text as best-effort Markdown.

- Fetches the rendered HTML article page (`www.{server}.org/content/{doi}v{N}.full`) and extracts Markdown — there is no keyless JATS source
- Resolves the latest version via the details API first, for the URL version and clean not-found handling
- Scope to `biorxiv`, `medrxiv`, or `both`; `both` is the default because the two servers share the `10.1101/` DOI prefix. Only the DOI resolution fans out — the full-text fetch targets the single server that answered, named in the output `server` field
- Long articles page via `offset`/`limit` character chunking (`totalChars`, `remainingChars`, `hasMore`); the extracted article is cached per version, so paging costs one origin fetch rather than one per chunk
- PDF-only preprints and blocked/challenge pages return a typed `fulltext_unavailable` error routing to `biorxiv_get_preprint`
- An origin rate limit (HTTP 429) returns a retryable `rate_limited` error carrying the origin's `Retry-After` wait, rather than a bare fetch failure. Both origins this tool touches can hit it — the article page during the full-text fetch, `api.biorxiv.org` during version resolution — and the recovery hint names which of them are limiting, since `biorxiv_get_preprint` is only a useful fallback while the metadata origin is answering

---

### `biorxiv_list_categories`

Return the static subject category taxonomy for both servers.

- No API call — hardcoded static list (~30 bioRxiv + ~50 medRxiv categories)
- Use to validate category strings before passing to `biorxiv_list_recent`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

bioRxiv-specific:

- `BiorxivApiService` wraps `api.biorxiv.org` — details, publications, and crosswalk endpoints with retry and exponential backoff. An origin rate limit (HTTP 429) is classified as a retryable `rate_limited` error carrying the parsed `Retry-After` wait; the upstream response body never reaches the error payload
- `EuropePmcService` wraps the EuropePMC search endpoint for relevance-ranked keyword and/or author results. An origin rate limit (HTTP 429) is classified the same way as the JSON API's — a retryable `rate_limited` error carrying the parsed `Retry-After` wait, with the upstream response body kept out of the error payload
- `BiorxivFullTextService` fetches and extracts Markdown from the rendered HTML article pages on `www.biorxiv.org` / `www.medrxiv.org` — a distinct origin from the JSON API
- Two-server fan-out via `Promise.allSettled` — both `biorxiv` and `medrxiv` queried in parallel when `server="both"`, results merged and deduplicated by DOI
- Polite `User-Agent` header including a mailto address (`BIORXIV_MAILTO` env var) per Cold Spring Harbor Lab API guidelines
- Pairs with **pubmed-mcp-server** (post-publication), **openalex-mcp-server** (citation analytics), and **crossref-mcp-server** (DOI metadata)

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).

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
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
