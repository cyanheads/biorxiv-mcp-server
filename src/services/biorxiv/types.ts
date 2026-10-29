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
  /** Upstream's spelling (`"bioRxiv"`, `"medRxiv"`); records take the queried server instead */
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

/**
 * A single crosswalk record from /pubs — keyed by DOI or listed by
 * publication-date interval — or a /publisher row, which carries six keys and
 * names the preprint as `biorxiv_doi` rather than `preprint_doi`.
 */
export interface RawPublishedRecord {
  biorxiv_doi?: string;
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

/**
 * Envelope returned by /pubs. An interval page reports `total` as a string
 * ("449") and echoes `cursor` as a number at 0 and a string after it; a page
 * with no rows ("no articles found …") carries `status` alone.
 */
export interface RawPublishedResponse {
  collection?: RawPublishedRecord[];
  messages?: Array<{
    status?: string;
    interval?: string;
    total?: number | string;
    count?: number;
    cursor?: number | string;
  }>;
}

// ─── Domain types ───────────────────────────────────────────────────────────

/** A single preprint revision with normalized optional fields */
export interface PreprintRevision {
  /**
   * The preprint's latest-revision abstract — upstream repeats it on every
   * revision. `getDetails` sets it on the latest revision only; a listing row
   * carries it whichever revision the row is.
   */
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
  /** The server that was queried — never the upstream spelling (`"bioRxiv"`) */
  server: BiorxivServer;
  title?: string;
  type?: string;
  version?: string;
}

/** Pagination metadata for a single server */
export interface ServerPaginationState {
  cursor: number;
  /**
   * Upstream `count_new_papers`: the preprints whose first version posted in the
   * interval, for the applied filters — the same on every cursor page. Absent
   * when the page carries no readable count (an empty interval, a cursor past
   * the last page), never defaulted to 0.
   */
  newPreprints?: number;
  /** Rows in the interval — one per revision posted in it, not one per preprint */
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

/**
 * What a publication-date listing reads: one server's `/pubs` interval, or
 * bioRxiv's `/publisher` interval for one journal DOI prefix (`10.7554`) — that
 * endpoint takes no server and lists bioRxiv preprints alone.
 */
export type PublishedListingSource = BiorxivServer | { publisher: string };

/** Per-source result from the publication-date interval listing */
export interface PublishedListingResult {
  pagination: {
    cursor: number;
    /** Rows in the interval; absent when the page held none, since upstream then reports no total */
    total?: number;
  };
  publications: PublishedVersion[];
  /**
   * True when a publisher prefix was sent and the API answered `status:
   * "publisher string not recognized"` with no rows — it could not read the
   * prefix, so the empty `publications` is not a result. Absent otherwise.
   */
  publisherNotRecognized?: true;
  /**
   * Upstream rows this page served — the requested slice of the upstream
   * page, counting any dropped for naming no preprint. The cursor plus this
   * count is the offset the next page starts from; zero only when the page
   * was empty upstream.
   */
  rowCount: number;
}

/** Hardcoded subject category taxonomy for bioRxiv and medRxiv */
export interface CategoryTaxonomy {
  biorxiv: string[];
  medrxiv: string[];
}
