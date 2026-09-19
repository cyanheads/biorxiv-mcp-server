/**
 * @fileoverview Server-specific configuration for biorxiv-mcp-server. Parses
 * domain env vars (BIORXIV_MAILTO, BIORXIV_API_BASE_URL, EUROPEPMC_API_BASE_URL,
 * BIORXIV_WEB_BASE_URL, MEDRXIV_WEB_BASE_URL) separately from the framework's
 * core config. Lazy-parsed on first access. `parseEnvConfig` reads an empty
 * value or an unsubstituted MCPB `${user_config.X}` placeholder as unset, so a
 * blank optional field falls through to its default.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  mailto: z
    .email()
    .optional()
    .describe('Contact email for User-Agent header — optional, used for polite API access'),
  apiBaseUrl: z.url().default('https://api.biorxiv.org').describe('bioRxiv API base URL'),
  europePmcBaseUrl: z
    .url()
    .default('https://www.ebi.ac.uk/europepmc/webservices/rest')
    .describe('EuropePMC REST API base URL'),
  // Full-text HTML lives on the public websites, not the JSON API host — a
  // distinct origin per server. Overridable for testing or mirrors.
  biorxivWebBaseUrl: z
    .url()
    .default('https://www.biorxiv.org')
    .describe(
      'bioRxiv website base URL — source of rendered full-text HTML pages for biorxiv_get_fulltext',
    ),
  medrxivWebBaseUrl: z
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
