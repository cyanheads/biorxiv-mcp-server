#!/usr/bin/env node
/**
 * @fileoverview biorxiv-mcp-server entry point. Initializes BiorxivApiService
 * and EuropePmcService in setup(), then registers all tool definitions with
 * createApp().
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initBiorxivApiService } from './services/biorxiv/biorxiv-service.js';
import { initEuropePmcService } from './services/europe-pmc/europe-pmc-service.js';

await createApp({
  tools: [...allToolDefinitions],
  resources: [],
  prompts: [],
  instructions:
    'bioRxiv/medRxiv preprint server. Start with biorxiv_list_categories to see valid category strings for filtering. ' +
    'Use biorxiv_list_recent for date-range browsing, biorxiv_get_preprint for DOI lookup, ' +
    'biorxiv_search_preprints for keyword search (powered by EuropePMC), and ' +
    'biorxiv_get_published_version for full crosswalk metadata when a preprint has been accepted to a journal.',
  // Public hosted catalog — serve full landing inventory even when MCP_AUTH_MODE=jwt/oauth.
  landing: { requireAuth: false },
  setup(core) {
    initBiorxivApiService(core.config, core.storage);
    initEuropePmcService(core.config, core.storage);
  },
});
