/**
 * @fileoverview Server-specific configuration for biorxiv-mcp-server. Parses
 * domain env vars (BIORXIV_MAILTO, BIORXIV_API_BASE_URL, EUROPEPMC_API_BASE_URL)
 * separately from the framework's core config. Lazy-parsed on first access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  mailto: z.string().email().describe('Contact email for User-Agent header'),
  apiBaseUrl: z.string().url().default('https://api.biorxiv.org').describe('bioRxiv API base URL'),
  europePmcBaseUrl: z
    .string()
    .url()
    .default('https://www.ebi.ac.uk/europepmc/webservices/rest')
    .describe('EuropePMC REST API base URL'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    mailto: 'BIORXIV_MAILTO',
    apiBaseUrl: 'BIORXIV_API_BASE_URL',
    europePmcBaseUrl: 'EUROPEPMC_API_BASE_URL',
  });
  return _config;
}

export function resetServerConfig(): void {
  _config = undefined;
}
