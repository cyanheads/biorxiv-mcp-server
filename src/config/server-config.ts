/**
 * @fileoverview Server-specific configuration for biorxiv-mcp-server. Parses
 * domain env vars (BIORXIV_MAILTO, BIORXIV_API_BASE_URL, EUROPEPMC_API_BASE_URL)
 * separately from the framework's core config. Lazy-parsed on first access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  // z.preprocess strips MCPB placeholder strings (${user_config.X}) to undefined
  // so z.email() doesn't crash when the user leaves the optional field blank.
  mailto: z
    .preprocess(
      (v) => (typeof v === 'string' && v.startsWith('${') ? undefined : v),
      z.string().email().optional(),
    )
    .describe('Contact email for User-Agent header — optional, used for polite API access'),
  apiBaseUrl: z.string().url().default('https://api.biorxiv.org').describe('bioRxiv API base URL'),
  europePmcBaseUrl: z
    .string()
    .url()
    .default('https://www.ebi.ac.uk/europepmc/webservices/rest')
    .describe('EuropePMC REST API base URL'),
  // Full-text HTML lives on the public websites, not the JSON API host — a
  // distinct origin per server. Overridable for testing or mirrors.
  biorxivWebBaseUrl: z
    .string()
    .url()
    .default('https://www.biorxiv.org')
    .describe(
      'bioRxiv website base URL — source of rendered full-text HTML pages for biorxiv_get_fulltext',
    ),
  medrxivWebBaseUrl: z
    .string()
    .url()
    .default('https://www.medrxiv.org')
    .describe(
      'medRxiv website base URL — source of rendered full-text HTML pages for biorxiv_get_fulltext',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mailto: 'BIORXIV_MAILTO',
    apiBaseUrl: 'BIORXIV_API_BASE_URL',
    europePmcBaseUrl: 'EUROPEPMC_API_BASE_URL',
    biorxivWebBaseUrl: 'BIORXIV_WEB_BASE_URL',
    medrxivWebBaseUrl: 'MEDRXIV_WEB_BASE_URL',
  });
  return _config;
}

export function resetServerConfig(): void {
  _config = undefined;
}
