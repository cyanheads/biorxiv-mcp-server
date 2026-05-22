/**
 * @fileoverview Domain types for the EuropePMC service. Covers raw API shapes
 * from the EuropePMC REST search endpoint and normalized domain types used by
 * the search_preprints tool handler.
 * @module services/europe-pmc/types
 */

// ─── Raw API shapes ─────────────────────────────────────────────────────────

/** A single result from the EuropePMC search endpoint */
export interface RawEuropePmcResult {
  abstractText?: string;
  authorString?: string;
  doi?: string;
  firstPublicationDate?: string;
  id?: string;
  source?: string;
  title?: string;
}

/** Envelope returned by the EuropePMC search endpoint */
export interface RawEuropePmcSearchResponse {
  hitCount?: number;
  nextCursorMark?: string;
  resultList?: {
    result?: RawEuropePmcResult[];
  };
}

// ─── Domain types ────────────────────────────────────────────────────────────

/** A preprint search result from EuropePMC, used for enrichment */
export interface EuropePmcResult {
  abstract?: string;
  authors?: string;
  doi: string;
  publishedDate?: string;
  title?: string;
}
