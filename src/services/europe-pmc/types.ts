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

/** Return value from EuropePmcService.search() — carries the upstream grand total alongside results */
export interface EuropePmcSearchResult {
  /** EuropePMC hitCount — total matching preprints regardless of the page size requested */
  hitCount: number;
  /**
   * Opaque cursor for the next page of ranked results. EuropePMC omits this
   * field entirely on the final page (REST v6.6 termination semantics), so its
   * absence — not a repeated value — signals that no further pages remain.
   */
  nextCursorMark?: string;
  results: EuropePmcResult[];
}
