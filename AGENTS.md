# Agent Protocol

**Server:** biorxiv-mcp-server
**Version:** 0.1.8
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.9`
**Engines:** Bun ≥1.3.2, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed before moving on. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';

export const listCategoriesTools = tool('biorxiv_list_categories', {
  description: 'List valid subject category strings for bioRxiv and medRxiv.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({}),

  output: z.object({
    biorxiv: z.array(z.string().describe('Category name')).describe('bioRxiv subject categories'),
    medrxiv: z.array(z.string().describe('Category name')).describe('medRxiv subject categories'),
  }),

  async handler(_input, ctx) {
    ctx.log.info('Executing biorxiv_list_categories tool');
    return getBiorxivApiService().getCategories();
  },

  format: (result) => [{
    type: 'text',
    text: [
      '**bioRxiv categories:**',
      result.biorxiv.map(c => `- ${c}`).join('\n'),
      '',
      '**medRxiv categories:**',
      result.medrxiv.map(c => `- ${c}`).join('\n'),
    ].join('\n'),
  }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  mailto: z.email().optional().describe('Contact email for User-Agent header — optional, for polite API access'),
  apiBaseUrl: z.url().default('https://api.biorxiv.org').describe('bioRxiv API base URL'),
  europePmcBaseUrl: z.url().default('https://www.ebi.ac.uk/europepmc/webservices/rest').describe('EuropePMC API base URL'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mailto: 'BIORXIV_MAILTO',
    apiBaseUrl: 'BIORXIV_API_BASE_URL',
    europePmcBaseUrl: 'EUROPEPMC_API_BASE_URL',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable rather than the internal path.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.recoveryFor(reason)` | Typed lookup of the contract `recovery` for a declared reason. Returns `{ recovery: { hint } }` for known reasons, `{}` otherwise. Spread into `ctx.fail` data to mirror the contract hint into `content[]`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT, `'default'` for stdio or HTTP+`MCP_AUTH_MODE=none`. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required (≥ 5 words, lint-validated). Spread `ctx.recoveryFor('reason')` into `data` to mirror the contract recovery onto the wire. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'doi_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'DOI resolves to empty collection on all requested servers',
    recovery: 'Verify DOI format (must be 10.1101/…) and try again.' },
],
async handler(input, ctx) {
  const result = await getBiorxivApiService().getDetails(input.doi, input.server ?? 'both');
  if (result.collection.length === 0) {
    throw ctx.fail('doi_not_found', `DOI not found: ${input.doi}`, {
      ...ctx.recoveryFor('doi_not_found'),
    });
  }
  return result;
}
```

**Fallback (no contract entry fits):** error factories or plain `Error`.

```ts
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Preprint not found', { doi });
throw serviceUnavailable('api.biorxiv.org unreachable', { url }, { cause: err });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # bioRxiv-specific env vars (BIORXIV_MAILTO, API base URLs)
  services/
    shared.ts                           # Shared utilities (asRc, detectHtmlError, SERVER_VERSION)
    biorxiv/
      biorxiv-service.ts                # BiorxivApiService — details, publications, pubs endpoints
      types.ts                          # Domain types (Preprint, PublishedVersion, …)
    europe-pmc/
      europe-pmc-service.ts             # EuropePmcService — preprint keyword search
      types.ts                          # EuropePMC response types
  mcp-server/
    tools/definitions/
      biorxiv-get-preprint.tool.ts
      biorxiv-list-recent.tool.ts
      biorxiv-search-preprints.tool.ts
      biorxiv-get-published-version.tool.ts
      biorxiv-list-categories.tool.ts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `biorxiv-get-preprint.tool.ts` |
| Tool/resource/prompt names | snake_case | `biorxiv_get_preprint` |
| Directories | kebab-case | `src/services/biorxiv/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Fetch preprint metadata by DOI.'` |

---

## Domain Conventions

- **DOI format:** `10.1101/YYYY.MM.DD.NNNNNN`. Validate on input — the bioRxiv API returns empty collections for malformed DOIs without an error code.
- **Server parameter:** `"biorxiv" | "medrxiv" | "both"`. Default to `"both"` for discovery tools, `"biorxiv"` for resolution tools. Fan-out via `Promise.allSettled` when `"both"`.
- **Pagination:** integer `cursor` offset (0, 30, 60, …). Page size is fixed at 30 by the API — do not expose a `limit` parameter.
- **Two-server pagination:** when `server="both"`, surface per-server state: `{ biorxiv: { cursor, total }, medrxiv: { cursor, total } }`. A merged cursor is ambiguous.
- **EuropePMC enrichment:** `biorxiv_search_preprints` uses EuropePMC for relevance then enriches matching DOIs via the details endpoint. Enrichment routes based on `input.server` — when explicit ("biorxiv" or "medrxiv"), always use that server. `10.1101/` prefix is used as a hint only within `server="both"` to prefer bioRxiv first, but is not a reliable discriminator (both servers share this prefix).
- **`format()` must be content-complete:** Claude Desktop reads `content[]` from `format()`, not `structuredContent`. Revision list, crosswalk data, pagination state, and abstracts must all appear in the rendered markdown, not just counts.
- **Polite access:** include `BIORXIV_MAILTO` in the `User-Agent` header when set: `biorxiv-mcp-server/0.1.0 (mailto:${config.mailto})`. The env var is optional — omit the mailto segment when not configured.

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest` |
| `git-wrapup` | Version-bump, changelog, commit, and tag workflow |
| `release-and-publish` | Ship a release: verification gate, push commits+tags, publish to npm / MCP Registry / GHCR |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |
| `report-issue-framework` | File bug/feature request against @cyanheads/mcp-ts-core |
| `report-issue-local` | File bug/feature request against this server's repo |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-05-21`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run test` | Run tests |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run lint:packaging` | Verify env var alignment between `manifest.json` and `server.json` |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run list-skills` | Surface available local skills for sub-agents |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` to opt out; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies alignment.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getBiorxivApiService } from '@/services/biorxiv/biorxiv-service.js';
import { getEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data — including revision list, crosswalk fields, abstract, and pagination state
- [ ] bioRxiv API wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] bioRxiv API wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data (e.g., `published` field may be `"NA"` — surface it as absent, not empty)
- [ ] bioRxiv API wrapping: tests include at least one sparse payload case with omitted upstream fields
- [ ] `BIORXIV_MAILTO` included in outbound User-Agent header when set (optional env var)
- [ ] DOI format validated on input (`10.1101/` prefix check) before calling API
- [ ] Two-server fan-out uses `Promise.allSettled`; partial failures reported per-DOI in `failed[]`
- [ ] `biorxiv_list_recent` with `server="both"` surfaces per-server pagination state, not a merged cursor
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
