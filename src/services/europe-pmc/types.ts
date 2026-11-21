/**
 * @fileoverview Domain types for the EuropePMC service. Covers raw API shapes
 * from the EuropePMC REST search endpoint and normalized domain types used by
 * the search_preprints tool handler.
 * @module services/europe-pmc/types
 */

// ─── Raw API shapes ─────────────────────────────────────────────────────────

/**
 * A single result from the EuropePMC search endpoint. `abstractText` appears only
 * under `resultType=core`; the `lite` result type never carries it.
 */
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

/** Default number of ranked rows requested per page. */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Ranked rows one call reads, bounding enrichment and abstract lookups. */
export const MAX_SEARCH_LIMIT = 100;

/**
 * A preprint search result from EuropePMC, used for enrichment. Carries no
 * abstract: the ranked search uses the `lite` result type, and abstracts come
 * from `EuropePmcService.getAbstracts`.
 */
export interface EuropePmcResult {
  authors?: string;
  doi: string;
  publishedDate?: string;
  title?: string;
}

/** Return value from EuropePmcService.search() — carries the upstream grand total alongside results */
export interface EuropePmcSearchResult {
  /** The author sent in the AUTH clause, when present. */
  author?: string;
  /** Total matches reported by EuropePMC, if supplied. */
  hitCount?: number;
  /** Opaque upstream cursor, retained on full pages that supply one. */
  nextCursorMark?: string;
  results: EuropePmcResult[];
  /** Number of upstream rows on the page before DOI filtering. */
  rowCount: number;
}
