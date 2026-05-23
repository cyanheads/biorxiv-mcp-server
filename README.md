<div align="center">
  <h1>@cyanheads/biorxiv-mcp-server</h1>
  <p><b>Search and retrieve bioRxiv and medRxiv preprints — by DOI, date interval, or keyword — via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/biorxiv-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/biorxiv-mcp-server) [![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/biorxiv-mcp-server/releases/latest/download/biorxiv-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=biorxiv-mcp-server&config=eyJjb21tYW5kIjoibnB4IC15IEBjeWFuaGVhZHMvYmlvcnhpdi1tY3Atc2VydmVyIn0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22biorxiv-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fbiorxiv-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Five tools for working with bioRxiv and medRxiv preprint data:

| Tool | Description |
|:---|:---|
| `biorxiv_get_preprint` | Fetch full metadata, abstract, revision history, and journal crosswalk for one or more preprints by DOI |
| `biorxiv_list_recent` | List preprints posted or updated within a date interval, with optional server and category filters |
| `biorxiv_search_preprints` | Search preprints by keyword via EuropePMC for relevance ranking, enriched with bioRxiv/medRxiv metadata |
| `biorxiv_get_published_version` | Resolve a preprint DOI to its journal publication record (journal DOI, name, published date) |
| `biorxiv_list_categories` | List valid subject category strings for bioRxiv and medRxiv |

### `biorxiv_get_preprint`

Fetch preprint metadata by DOI — all revisions in one call.

- Batch fetch up to 10 DOIs in a single request
- Each DOI returns the full revision history in `collection[]` — one API call per DOI, no enumeration loop
- Includes title, authors, abstract, category, license, PDF link (`jatsxml`), and published journal DOI when the preprint has been accepted
- Scope to `biorxiv`, `medrxiv`, or `both`; when `both`, each DOI fans out in parallel and partial failures report per-DOI in `failed[]`

---

### `biorxiv_list_recent`

Page through preprints in a date interval.

- Server-side category filtering via `?category=…` — pass a value from `biorxiv_list_categories`
- Fixed page size of 30 (API constraint); advance with integer `cursor` (0, 30, 60, …)
- Response includes `total` count per server for calculating remaining pages
- When `server="both"`, each server paginates independently; response surfaces per-server pagination state (`{ biorxiv: { cursor, total }, medrxiv: { cursor, total } }`)

---

### `biorxiv_search_preprints`

Keyword search with relevance ranking.

- EuropePMC powers relevance ranking (indexes new preprints within 1–2 days of posting); bioRxiv/medRxiv API provides canonical metadata enrichment
- Covers both servers by default; scope down with `server`
- Optional date range filters (`date_from`, `date_to`)
- Enrichment failures degrade gracefully to EuropePMC-only metadata, surfaced via `partial_results`

---

### `biorxiv_get_published_version`

Resolve a preprint DOI to its journal publication crosswalk.

- Uses the `/pubs/{server}/{doi}` endpoint for richer metadata than the `published` field in `biorxiv_get_preprint`
- Returns journal DOI, journal name, published date, and corresponding author institution
- Use when the preprint's `published` field is non-null and you need the full crosswalk record

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

- `BiorxivApiService` wraps `api.biorxiv.org` — details, publications, and crosswalk endpoints with retry and exponential backoff
- `EuropePmcService` wraps the EuropePMC search endpoint for relevance-ranked keyword results
- Two-server fan-out via `Promise.allSettled` — both `biorxiv` and `medrxiv` queried in parallel when `server="both"`, results merged and deduplicated by DOI
- Polite `User-Agent` header including a mailto address (`BIORXIV_MAILTO` env var) per Cold Spring Harbor Lab API guidelines
- Pairs with **pubmed-mcp-server** (post-publication), **openalex-mcp-server** (citation analytics), and **crossref-mcp-server** (DOI metadata)

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "biorxiv": {
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
    "biorxiv": {
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
    "biorxiv": {
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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).

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
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spillover for large result sets (Node only). | — |
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

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and initializes services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Five tools across bioRxiv and medRxiv. |
| `src/services/biorxiv` | `BiorxivApiService` — details, publications, and crosswalk endpoint wrappers with retry. |
| `src/services/europe-pmc` | `EuropePmcService` — preprint keyword search endpoint wrapper. |
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
