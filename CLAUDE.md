# Agent Protocol

**Server:** biorxiv-mcp-server
**Version:** 0.2.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.12.3`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
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
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
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
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. |
| `ctx.inputs` | Reader over a retried request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped`. Empty on the first round. |
| `ctx.recoveryFor(reason)` | Typed lookup of the contract `recovery` for a declared reason. Returns `{ recovery: { hint } }` for known reasons, `{}` otherwise. Spread into `ctx.fail` data to mirror the contract hint into `content[]`. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required (≥ 5 words, lint-validated). Spread `ctx.recoveryFor('reason')` into `data` to mirror the contract recovery onto the wire. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

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

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

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
    shared.ts                           # Shared utilities (detectHtmlError, normalizeUpstreamText,
                                        #   isValidCalendarDate, parseRetryAfterSeconds, findRateLimit, describeWait,
                                        #   SERVER_VERSION)
    biorxiv/
      biorxiv-service.ts                # BiorxivApiService — details, publications, pubs endpoints
      types.ts                          # Domain types (Preprint, PublishedVersion, …)
    biorxiv-fulltext/
      biorxiv-fulltext-service.ts       # BiorxivFullTextService — article-page HTML → Markdown, cached per version
    europe-pmc/
      europe-pmc-service.ts             # EuropePmcService — preprint keyword search
      types.ts                          # EuropePMC response types
  mcp-server/
    tools/definitions/
      biorxiv-get-preprint.tool.ts
      biorxiv-list-recent.tool.ts
      biorxiv-search-preprints.tool.ts
      biorxiv-get-published-version.tool.ts
      biorxiv-get-fulltext.tool.ts
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
- **Server parameter:** `"biorxiv" | "medrxiv" | "both"`. Default to `"both"`, including for DOI-resolution tools — both servers issue `10.1101/` DOIs, so the DOI never identifies the server and a single-server default silently misses records held by the other. Fan out via `Promise.allSettled` when `"both"` and name the answering server in the output.
- **Pagination:** integer `cursor` offset (0, 30, 60, …). Page size is fixed at 30 by the API — do not expose a `limit` parameter.
- **Two-server pagination:** when `server="both"`, surface per-server state: `{ biorxiv: { cursor, total }, medrxiv: { cursor, total } }`. A merged cursor is ambiguous.
- **EuropePMC enrichment:** `biorxiv_search_preprints` uses EuropePMC for relevance then enriches matching DOIs via the details endpoint. Enrichment routes based on `input.server` — when explicit ("biorxiv" or "medrxiv"), always use that server. `10.1101/` prefix is used as a hint only within `server="both"` to prefer bioRxiv first, but is not a reliable discriminator (both servers share this prefix).
- **`format()` must be content-complete:** Claude Desktop reads `content[]` from `format()`, not `structuredContent`. Revision list, crosswalk data, pagination state, and abstracts must all appear in the rendered markdown, not just counts.
- **Polite access:** include `BIORXIV_MAILTO` in the `User-Agent` header when set: `biorxiv-mcp-server/0.1.0 (mailto:${config.mailto})`. The env var is optional — omit the mailto segment when not configured.

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

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
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest` |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent, self-refreshing local mirror of a bulk upstream dataset (embedded SQLite + FTS5) — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-05-21`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation.

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run list-skills` | Surface available local skills for sub-agents |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run release:github` | Create (or repair) a GitHub Release on the current version's annotated tag |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` to opt out; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies alignment.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.2.x/0.2.5.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.2.5 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

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
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
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
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
