/**
 * @fileoverview Tests for the server config schema — the MCPB placeholder strip
 * and the web base URL defaults across deployment shapes. This runs at startup
 * before anything else, so a regression here takes the whole server down.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

const WEB_URL_VARS = ['BIORXIV_WEB_BASE_URL', 'MEDRXIV_WEB_BASE_URL'] as const;

/** The literal `${user_config.NAME}` string MCPB leaves behind when a field is blank. */
const mcpbPlaceholder = (name: string) => `\${user_config.${name}}`;

beforeEach(() => {
  resetServerConfig();
  for (const name of WEB_URL_VARS) vi.stubEnv(name, undefined as unknown as string);
  vi.stubEnv('BIORXIV_MAILTO', undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('web base URLs', () => {
  it('falls back to the public sites when nothing is set (stdio, no env)', () => {
    const config = getServerConfig();
    expect(config.biorxivWebBaseUrl).toBe('https://www.biorxiv.org');
    expect(config.medrxivWebBaseUrl).toBe('https://www.medrxiv.org');
  });

  it('honors an operator-supplied mirror', () => {
    vi.stubEnv('BIORXIV_WEB_BASE_URL', 'https://mirror.example.com/biorxiv');
    expect(getServerConfig().biorxivWebBaseUrl).toBe('https://mirror.example.com/biorxiv');
  });

  it('leaves a value containing $, { or } intact — only a leading placeholder is stripped', () => {
    vi.stubEnv('BIORXIV_WEB_BASE_URL', 'https://mirror.example.com/a$b{c}d');
    expect(getServerConfig().biorxivWebBaseUrl).toBe('https://mirror.example.com/a$b{c}d');
  });

  it('falls back to the default when MCPB leaves the placeholder unsubstituted', () => {
    vi.stubEnv('BIORXIV_WEB_BASE_URL', mcpbPlaceholder('BIORXIV_WEB_BASE_URL'));
    vi.stubEnv('MEDRXIV_WEB_BASE_URL', mcpbPlaceholder('MEDRXIV_WEB_BASE_URL'));
    const config = getServerConfig();
    expect(config.biorxivWebBaseUrl).toBe('https://www.biorxiv.org');
    expect(config.medrxivWebBaseUrl).toBe('https://www.medrxiv.org');
  });

  it('fails at startup rather than silently defaulting when the value is not a URL', () => {
    vi.stubEnv('BIORXIV_WEB_BASE_URL', 'not-a-url');
    expect(() => getServerConfig()).toThrow(/BIORXIV_WEB_BASE_URL/);
  });
});

describe('mailto', () => {
  it('falls back to undefined when MCPB leaves the placeholder unsubstituted', () => {
    vi.stubEnv('BIORXIV_MAILTO', mcpbPlaceholder('BIORXIV_MAILTO'));
    expect(getServerConfig().mailto).toBeUndefined();
  });

  it('keeps a real address', () => {
    vi.stubEnv('BIORXIV_MAILTO', 'preprints@example.org');
    expect(getServerConfig().mailto).toBe('preprints@example.org');
  });
});
