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
 * A funder entry in the bioRxiv API funder array. `name` and `id` are
 * misattributed upstream — they name an unrelated organization — so only
 * `award` is read.
 */
export interface RawFunderEntry {
  award?: string;
  id?: string;
  'id-type'?: string;
  name?: string;
}

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
  /** Either a plain string ("NA"), an array of funder objects, or absent */
  funder?: string | RawFunderEntry[];
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
    /** API returns total as a string (e.g. "915"), not a number */
    total?: number | string;
    count?: number;
    cursor?: number | string;
    message?: string;
    category?: string;
    /** Listing only: the applied funder filter (`"<name> : https://ror.org/<id>"`), or `"all"` */
    funder?: string;
    count_new_papers?: number | string;
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
  /** Upstream `award` values, verbatim and deduplicated; absent when there are none */
  awards?: string[];
  category?: string;
  date?: string;
  doi: string;
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

/** Server-side filters for the listing endpoint; both are sent when both are set */
export interface ListingFilters {
  /** Subject category, in any spelling `isValidCategory` accepts */
  category?: string | undefined;
  /** Bare 9-character ROR ID, already normalized — bioRxiv only */
  funder?: string | undefined;
}

/** Per-server result from the listing endpoint */
export interface ListingResult {
  /**
   * True when a category was sent but the API echoed `category: "all"` — it did
   * not apply the filter, so `preprints` is the unfiltered listing. Absent otherwise.
   */
  categoryIgnored?: true;
  /**
   * True when a funder was sent and the API answered `status: "funder value not
   * found"` with no collection — it holds no funder record for that ROR ID, so
   * the empty `preprints` is not a result. Absent otherwise.
   */
  funderNotFound?: true;
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
