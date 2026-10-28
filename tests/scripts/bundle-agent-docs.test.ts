/**
 * @fileoverview Regression tests for the `.mcpb` agent-doc strip: the bundle
 * cleaner (`scripts/clean-mcpb.ts`) and the post-bundle check
 * (`scripts/lint-packaging.ts` check 8) must remove `skills/`-style agent docs
 * only at an installed package's root, and keep the MCP SDK's runtime
 * `dist/ext/skills/` modules, without which a cleaned bundle fails at startup
 * with `ERR_MODULE_NOT_FOUND`.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEANER_AGENT_DOC_ENTRY,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';

interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], bundleLabel: string) => string[];
}

/**
 * Loaded by URL so `tsc` never pulls `scripts/lint-packaging.ts` into the test
 * program: its framework-repository fallback imports `../src/mcp-server/skills.js`,
 * which exists only there (cyanheads/mcp-ts-core#797).
 */
const lintPackaging: LintPackagingModule = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/parent/node_modules/child/lib/skills/loader.js',
  'node_modules/child/dist/framework-skills/index.js',
  'node_modules/child/dist/.claude/settings.js',
  'node_modules/@scope/skills/index.js',
  'skills/biorxiv-guide/SKILL.md',
  'dist/index.js',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/child/skills/guide/reference.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/@scope/child/.claude/settings.json',
  'node_modules/child/.agents/skills/guide.md',
  'node_modules/parent/node_modules/child/skills/guide/reference.md',
  'node_modules/@scope/parent/node_modules/@scope/child/framework-skills/x/notes.md',
  'node_modules/child/SKILL.md',
  'node_modules/child/docs/SKILL.md',
];

describe('bundle agent-doc strip', () => {
  it.each(RUNTIME_ENTRIES)('keeps runtime and published entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintPackaging.checkBundleEntries([entry], 'test.mcpb')).toEqual([]);
  });

  it.each(AGENT_DOC_ENTRIES)('removes package-root agent doc %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    const errors = lintPackaging.checkBundleEntries([entry], 'test.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(entry);
  });

  it('selects the same entries in the cleaner and the post-bundle check', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(CLEANER_AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(CLEANER_AGENT_DOC_ENTRY.flags);
  });
});
