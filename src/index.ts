#!/usr/bin/env node
/**
 * @fileoverview biorxiv-mcp-server entry point. Initializes BiorxivApiService,
 * EuropePmcService, and BiorxivFullTextService in setup(), then registers all
 * tool definitions with createApp().
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initBiorxivApiService } from './services/biorxiv/biorxiv-service.js';
import { initBiorxivFullTextService } from './services/biorxiv-fulltext/biorxiv-fulltext-service.js';
import { initEuropePmcService } from './services/europe-pmc/europe-pmc-service.js';

await createApp({
  name: 'biorxiv-mcp-server',
  title: 'biorxiv-mcp-server',
  tools: [...allToolDefinitions],
  resources: [],
  prompts: [],
  instructions:
    'bioRxiv/medRxiv preprints, addressed by 10.1101/ DOI and searched across both servers by default. Find preprints with biorxiv_search_preprints (keyword or author, ranked by EuropePMC) or biorxiv_list_recent (a date interval, filtered by a category string from biorxiv_list_categories). Resolve a DOI with biorxiv_get_preprint for metadata and revisions, biorxiv_get_fulltext for the article body as Markdown, and biorxiv_get_published_version for the journal crosswalk once a preprint has been published.',
  // Stateless HTTP: no tool gates on ctx.requestInput, so no session store is needed.
  sessionMode: 'stateless',
  // Public hosted catalog — serve full landing inventory even when MCP_AUTH_MODE=jwt/oauth.
  landing: { requireAuth: false },
  setup(core) {
    initBiorxivApiService(core.config, core.storage);
    initEuropePmcService(core.config, core.storage);
    initBiorxivFullTextService(core.config, core.storage);
  },
});
