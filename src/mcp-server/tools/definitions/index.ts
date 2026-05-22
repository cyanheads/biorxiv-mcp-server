/**
 * @fileoverview Barrel export for all tool definitions in this server.
 * Import allToolDefinitions into createApp() in src/index.ts.
 * @module mcp-server/tools/definitions/index
 */

export { biorxivGetPreprintTool } from './biorxiv-get-preprint.tool.js';
export { biorxivGetPublishedVersionTool } from './biorxiv-get-published-version.tool.js';
export { biorxivListCategoriesTool } from './biorxiv-list-categories.tool.js';
export { biorxivListRecentTool } from './biorxiv-list-recent.tool.js';
export { biorxivSearchPreprintsTool } from './biorxiv-search-preprints.tool.js';

import { biorxivGetPreprintTool } from './biorxiv-get-preprint.tool.js';
import { biorxivGetPublishedVersionTool } from './biorxiv-get-published-version.tool.js';
import { biorxivListCategoriesTool } from './biorxiv-list-categories.tool.js';
import { biorxivListRecentTool } from './biorxiv-list-recent.tool.js';
import { biorxivSearchPreprintsTool } from './biorxiv-search-preprints.tool.js';

export const allToolDefinitions = [
  biorxivListCategoriesTool,
  biorxivListRecentTool,
  biorxivGetPreprintTool,
  biorxivGetPublishedVersionTool,
  biorxivSearchPreprintsTool,
] as const;
