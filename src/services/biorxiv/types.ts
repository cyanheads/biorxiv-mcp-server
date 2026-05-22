/**
 * @fileoverview Domain types for the bioRxiv API service. Covers raw JSON
 * shapes returned by the API alongside normalized domain types used by tool
 * handlers. Raw types default fields to optional to faithfully represent
 * the API's sparsity — absence is preserved rather than fabricated.
 * @module services/biorxiv/types
 */

/** Server identifier accepted by api.biorxiv.org */
export type BiorxivServer = 'biorxiv' | 'medrxiv';

/** Broader "both" is accepted at tool level and fanned out by the service. */
export type ServerParam = BiorxivServer | 'both';

// ─── Raw API shapes ─────────────────────────────────────────────────────────

/**
 * A single preprint revision as returned by the /details endpoint.
 * Fields marked optional may be absent from real upstream payloads.
 */
export interface RawPreprintRevision {
  abstract?: string;
  author_corresponding?: string;
  author_corresponding_institution?: string;
  authors?: string;
  category?: string;
  date?: string;
  doi: string;
  funder?: string;
  jatsxml?: string;
  license?: string;
  /** Journal DOI after publication, or "NA" when not yet published */
  published?: string;
  server?: string;
  title?: string;
  type?: string;
  version?: string;
}

/** Envelope returned by /details/{server}/{doi} */
export interface RawDetailsResponse {
  collection?: RawPreprintRevision[];
  messages?: Array<{
    status?: string;
    total?: number;
    count?: number;
    cursor?: number | string;
    message?: string;
    category?: string;
    count_new_papers?: number;
  }>;
}

/** A single crosswalk record from /pubs/{server}/{doi} */
export interface RawPublishedRecord {
  preprint_abstract?: string;
  preprint_author_corresponding?: string;
  preprint_author_corresponding_institution?: string;
  preprint_authors?: string;
  preprint_category?: string;
  preprint_date?: string;
  preprint_doi?: string;
  preprint_title?: string;
  published_date?: string;
  published_doi?: string;
  published_journal?: string;
}

/** Envelope returned by /pubs/{server}/{doi} */
export interface RawPublishedResponse {
  collection?: RawPublishedRecord[];
  messages?: Array<{
    status?: string;
    total?: number;
    count?: number;
  }>;
}

// ─── Domain types ───────────────────────────────────────────────────────────

/** A single preprint revision with normalized optional fields */
export interface PreprintRevision {
  abstract?: string;
  authorCorresponding?: string;
  authorCorrespondingInstitution?: string;
  authors?: string;
  category?: string;
  date?: string;
  doi: string;
  funder?: string;
  jatsxmlUrl?: string;
  license?: string;
  /** Non-null when the preprint has been published; "NA" is normalized to undefined */
  publishedJournalDoi?: string;
  server?: string;
  title?: string;
  type?: string;
  version?: string;
}

/** Pagination metadata for a single server */
export interface ServerPaginationState {
  cursor: number;
  total: number;
}

/** Per-server result from the listing endpoint */
export interface ListingResult {
  pagination: ServerPaginationState;
  preprints: PreprintRevision[];
}

/** Crosswalk record from the /pubs endpoint */
export interface PublishedVersion {
  preprintAbstract?: string;
  preprintAuthorCorresponding?: string;
  preprintAuthorCorrespondingInstitution?: string;
  preprintAuthors?: string;
  preprintCategory?: string;
  preprintDate?: string;
  preprintDoi: string;
  preprintTitle?: string;
  publishedDate?: string;
  publishedDoi?: string;
  publishedJournal?: string;
}

/** Hardcoded subject category taxonomy for bioRxiv and medRxiv */
export interface CategoryTaxonomy {
  biorxiv: string[];
  medrxiv: string[];
}
