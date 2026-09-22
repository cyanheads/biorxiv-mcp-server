/**
 * @fileoverview BiorxivApiService — wraps api.biorxiv.org endpoints for
 * preprint details (/details), date-range listing (/details with date interval),
 * and crosswalk (/pubs, keyed by preprint DOI or by journal DOI). Owns the
 * category taxonomy and the API's category spelling, and flags a listing whose
 * category filter the API ignored. All methods retry with exponential backoff. Parses
 * and normalizes raw JSON into domain types. Detects HTML error pages, and
 * classifies an origin rate limit (HTTP 429) as its own retryable
 * `rate_limited` condition carrying the parsed `Retry-After` wait — never the
 * upstream response body.
 * @module services/biorxiv/biorxiv-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError, rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  describeWait,
  detectHtmlError,
  normalizeUpstreamText,
  parseRetryAfterSeconds,
  SERVER_VERSION,
} from '@/services/shared.js';
import type {
  BiorxivServer,
  CategoryTaxonomy,
  ListingResult,
  PreprintRevision,
  PublishedVersion,
  RawDetailsResponse,
  RawPreprintRevision,
  RawPublishedRecord,
  RawPublishedResponse,
} from './types.js';

// ─── Hardcoded category taxonomy ─────────────────────────────────────────────
/**
 * No API endpoint provides this; it changes infrequently. Maintained here, and
 * limited to the categories the listing endpoint actually filters on: bioRxiv
 * "Epidemiology" and "Clinical Trials" and medRxiv "Vascular Medicine" appear
 * on the websites, but the API answers every spelling of them with its
 * unfiltered listing, so they are left out rather than advertised as filters.
 */
const CATEGORIES: CategoryTaxonomy = {
  biorxiv: [
    'Animal Behavior and Cognition',
    'Biochemistry',
    'Bioengineering',
    'Bioinformatics',
    'Biophysics',
    'Cancer Biology',
    'Cell Biology',
    'Developmental Biology',
    'Ecology',
    'Evolutionary Biology',
    'Genetics',
    'Genomics',
    'Immunology',
    'Microbiology',
    'Molecular Biology',
    'Neuroscience',
    'Paleontology',
    'Pathology',
    'Pharmacology and Toxicology',
    'Physiology',
    'Plant Biology',
    'Scientific Communication and Education',
    'Synthetic Biology',
    'Systems Biology',
    'Zoology',
  ],
  medrxiv: [
    'Addiction Medicine',
    'Allergy and Immunology',
    'Anesthesia',
    'Cardiovascular Medicine',
    'Dentistry and Oral Medicine',
    'Dermatology',
    'Emergency Medicine',
    'Endocrinology',
    'Epidemiology',
    'Forensic Medicine',
    'Gastroenterology',
    'Genetic and Genomic Medicine',
    'Geriatric Medicine',
    'Health Economics',
    'Health Informatics',
    'Health Policy',
    'Health Systems and Quality Improvement',
    'Hematology',
    'HIV/AIDS',
    'Infectious Diseases',
    'Intensive Care and Critical Care Medicine',
    'Medical Education',
    'Medical Ethics',
    'Nephrology',
    'Neurology',
    'Nursing',
    'Nutrition',
    'Obstetrics and Gynecology',
    'Occupational and Environmental Health',
    'Oncology',
    'Ophthalmology',
    'Orthopedics',
    'Otolaryngology',
    'Pain Medicine',
    'Palliative Medicine',
    'Pathology',
    'Pediatrics',
    'Pharmacology and Therapeutics',
    'Primary Care Research',
    'Psychiatry and Clinical Psychology',
    'Public and Global Health',
    'Radiology and Imaging',
    'Rehabilitation Medicine and Physical Therapy',
    'Respiratory Medicine',
    'Rheumatology',
    'Sexual and Reproductive Health',
    'Sports Medicine',
    'Surgery',
    'Toxicology',
    'Transplantation',
    'Urology',
  ],
};

/**
 * A category in the API's own spelling: lowercase, with `/` and `_` read as a
 * space (`HIV/AIDS` → `hiv aids`). This is the only form the listing endpoint
 * filters on — a slash, raw or percent-encoded, makes it ignore the filter —
 * and the form every record's `category` field carries, so it doubles as the
 * key input is matched on: `Cell Biology`, `cell biology`, and `CELL_BIOLOGY`
 * name the same category. `-` is read as a space too, so the websites'
 * collection slugs (`cell-biology`, `hiv-aids`) match; no category name
 * contains a hyphen of its own.
 */
function apiCategory(category: string): string {
  return category.toLowerCase().replace(/[/_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pre-built sets for O(1) category membership checks, keyed by API spelling
const BIORXIV_CATEGORIES = new Set(CATEGORIES.biorxiv.map(apiCategory));
const MEDRXIV_CATEGORIES = new Set(CATEGORIES.medrxiv.map(apiCategory));

/**
 * The `messages[0].category` echo for a listing the API did not filter. It
 * appears on every unfiltered page, so it only means "filter ignored" when a
 * category was sent; an empty page carries no category echo at all.
 */
const UNFILTERED_ECHO = 'all';

/**
 * The one status this service classifies itself rather than treating as a bug.
 * Passing it to `fetchWithTimeout` only lowers the log severity from `error` to
 * `debug`; the thrown error and its classification are unchanged.
 */
const EXPECTED_STATUSES = [429];

/**
 * Re-throws a failed api.biorxiv.org call, classifying HTTP 429 as its own
 * retryable `rate_limited` condition. Everything else — 5xx, timeout, network
 * error, the HTML-error guard below — re-throws untouched for the framework's
 * auto-classifier.
 *
 * `fetchWithTimeout` attaches the upstream response body to `err.data`
 * (`body`/`responseBody`), so the replacement payload is built from scratch
 * rather than spread: only the parsed `Retry-After` crosses into it. Retry is
 * not this function's concern — `withRetry` already honors `data.retryAfter`
 * and fails fast when the requested wait exceeds its cap, so by the time a 429
 * reaches here the waiting is over and only classification is left.
 */
function rethrowClassified(err: unknown): never {
  const data =
    err instanceof McpError
      ? (err.data as { status?: unknown; retryAfter?: unknown } | undefined)
      : undefined;
  if (data?.status !== 429) throw err;

  const retryAfter = parseRetryAfterSeconds(data.retryAfter);
  const wait = describeWait(retryAfter);
  throw rateLimited(
    retryAfter === undefined
      ? 'api.biorxiv.org is rate-limiting this host (HTTP 429).'
      : `api.biorxiv.org is rate-limiting this host (HTTP 429) and asked for a ${retryAfter}-second wait before the next request.`,
    {
      reason: 'rate_limited',
      retryable: true,
      ...(retryAfter !== undefined && { retryAfter }),
      recovery: {
        hint: `Wait ${wait} before querying api.biorxiv.org again — every preprint metadata tool shares this origin, so they are all limited together.`,
      },
    },
    { cause: err },
  );
}

// ─── Normalization helpers ───────────────────────────────────────────────────

function normalizeRevision(raw: RawPreprintRevision): PreprintRevision {
  const rev: PreprintRevision = { doi: raw.doi };
  const title = normalizeUpstreamText(raw.title);
  if (title) rev.title = title;
  if (raw.authors) rev.authors = raw.authors;
  if (raw.author_corresponding) rev.authorCorresponding = raw.author_corresponding;
  if (raw.author_corresponding_institution)
    rev.authorCorrespondingInstitution = raw.author_corresponding_institution;
  if (raw.date) rev.date = raw.date;
  if (raw.version) rev.version = raw.version;
  if (raw.type) rev.type = raw.type;
  if (raw.license) rev.license = raw.license;
  if (raw.category) rev.category = raw.category;
  if (raw.jatsxml) rev.jatsxmlUrl = raw.jatsxml;
  const abstract = normalizeUpstreamText(raw.abstract);
  if (abstract) rev.abstract = abstract;
  if (raw.funder && raw.funder !== 'NA') {
    if (Array.isArray(raw.funder)) {
      const names = raw.funder
        .map((f) => f.name ?? '')
        .filter(Boolean)
        .join('; ');
      if (names) rev.funder = names;
    } else {
      rev.funder = raw.funder;
    }
  }
  // Normalize "NA" to absent — callers should check undefined, not "NA"
  if (raw.published && raw.published !== 'NA') rev.publishedJournalDoi = raw.published;
  if (raw.server) rev.server = raw.server;
  return rev;
}

/** Normalize a `/pubs` crosswalk record; undefined when it names no preprint. */
function normalizePublished(record: RawPublishedRecord): PublishedVersion | undefined {
  if (!record.preprint_doi) return;
  const pv: PublishedVersion = { preprintDoi: record.preprint_doi };
  if (record.published_doi) pv.publishedDoi = record.published_doi;
  if (record.published_journal) pv.publishedJournal = record.published_journal;
  if (record.published_date) pv.publishedDate = record.published_date;
  const preprintTitle = normalizeUpstreamText(record.preprint_title);
  if (preprintTitle) pv.preprintTitle = preprintTitle;
  if (record.preprint_authors) pv.preprintAuthors = record.preprint_authors;
  if (record.preprint_category) pv.preprintCategory = record.preprint_category;
  if (record.preprint_date) pv.preprintDate = record.preprint_date;
  const preprintAbstract = normalizeUpstreamText(record.preprint_abstract);
  if (preprintAbstract) pv.preprintAbstract = preprintAbstract;
  if (record.preprint_author_corresponding)
    pv.preprintAuthorCorresponding = record.preprint_author_corresponding;
  if (record.preprint_author_corresponding_institution)
    pv.preprintAuthorCorrespondingInstitution = record.preprint_author_corresponding_institution;
  return pv;
}

// ─── Service class ───────────────────────────────────────────────────────────

export class BiorxivApiService {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    const serverCfg = getServerConfig();
    this.baseUrl = serverCfg.apiBaseUrl;
    this.userAgent = serverCfg.mailto
      ? `biorxiv-mcp-server/${SERVER_VERSION} (mailto:${serverCfg.mailto})`
      : `biorxiv-mcp-server/${SERVER_VERSION}`;
  }

  /** Returns the hardcoded subject category taxonomy. No API call. */
  getCategories(): CategoryTaxonomy {
    return CATEGORIES;
  }

  /**
   * Returns true if the given category string is valid for the specified server(s).
   * Matching is case-insensitive with `_`, `-`, and `/` read as a space, so the
   * taxonomy spelling, the lowercase spelling records carry, and the websites'
   * collection slugs all match.
   * When server is 'both', the category must exist in at least one server's taxonomy.
   */
  isValidCategory(category: string, server: BiorxivServer | 'both' = 'both'): boolean {
    const key = apiCategory(category);
    if (server === 'both') return BIORXIV_CATEGORIES.has(key) || MEDRXIV_CATEGORIES.has(key);
    return (server === 'biorxiv' ? BIORXIV_CATEGORIES : MEDRXIV_CATEGORIES).has(key);
  }

  /**
   * Fetch all revisions for a DOI from a single server.
   * Returns an empty collection if the DOI is not found on this server.
   * Throws a retryable `rate_limited` error when the origin returns HTTP 429.
   */
  async getDetails(doi: string, server: BiorxivServer, ctx: Context): Promise<PreprintRevision[]> {
    const encodedDoi = doi.split('/').map(encodeURIComponent).join('/');
    const url = `${this.baseUrl}/details/${server}/${encodedDoi}/0/json`;
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, 15_000, ctx, {
            signal: ctx.signal,
            headers: { 'User-Agent': this.userAgent },
            expectedStatuses: EXPECTED_STATUSES,
          });
          const text = await response.text();
          if (detectHtmlError(text)) {
            throw serviceUnavailable(
              'api.biorxiv.org returned HTML — likely rate-limited or down.',
              { url },
            );
          }
          const data = JSON.parse(text) as RawDetailsResponse;
          return (data.collection ?? []).map(normalizeRevision);
        },
        {
          operation: 'BiorxivApiService.getDetails',
          context: ctx,
          baseDelayMs: 500,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      rethrowClassified(err);
    }
  }

  /**
   * Fetch preprints posted or revised within a date interval from a single server.
   * `cursor` is an integer offset (0, 30, 60, …). Page size is always 30.
   * `category` is sent in the API's spelling whatever form the caller used.
   * Returns listing result with pagination state, flagged `categoryIgnored` when
   * a category was sent but the API answered with its unfiltered listing.
   * Throws a retryable `rate_limited` error when the origin returns HTTP 429.
   */
  async getListing(
    server: BiorxivServer,
    startDate: string,
    endDate: string,
    cursor: number,
    category: string | undefined,
    ctx: Context,
  ): Promise<ListingResult> {
    let url = `${this.baseUrl}/details/${server}/${startDate}/${endDate}/${cursor}/json`;
    if (category) {
      url += `?category=${encodeURIComponent(apiCategory(category))}`;
    }

    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, 20_000, ctx, {
            signal: ctx.signal,
            headers: { 'User-Agent': this.userAgent },
            expectedStatuses: EXPECTED_STATUSES,
          });
          const text = await response.text();
          if (detectHtmlError(text)) {
            throw serviceUnavailable(
              'api.biorxiv.org returned HTML — likely rate-limited or down.',
              { url },
            );
          }
          const data = JSON.parse(text) as RawDetailsResponse;
          const msg = data.messages?.[0];
          const rawTotal = msg?.total;
          const total =
            typeof rawTotal === 'number'
              ? rawTotal
              : typeof rawTotal === 'string'
                ? parseInt(rawTotal, 10) || 0
                : 0;
          const preprints = (data.collection ?? []).map(normalizeRevision);
          const categoryIgnored = !!category && msg?.category === UNFILTERED_ECHO;
          return {
            preprints,
            pagination: { cursor, total },
            ...(categoryIgnored && { categoryIgnored }),
          };
        },
        {
          operation: 'BiorxivApiService.getListing',
          context: ctx,
          baseDelayMs: 500,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      rethrowClassified(err);
    }
  }

  /**
   * Resolve a preprint DOI to its published journal record via /pubs endpoint.
   * Returns undefined when the preprint is not yet published — and for every
   * `10.64898/` DOI, which this path form never parses (see
   * {@link getPublishedVersionByJournalDoi} for the lookup that does resolve them).
   * Throws a retryable `rate_limited` error when the origin returns HTTP 429.
   */
  async getPublishedVersion(
    doi: string,
    server: BiorxivServer,
    ctx: Context,
  ): Promise<PublishedVersion | undefined> {
    const encodedDoi = doi.split('/').map(encodeURIComponent).join('/');
    const record = (await this.fetchCrosswalk(encodedDoi, server, 'getPublishedVersion', ctx))[0];
    return record ? normalizePublished(record) : undefined;
  }

  /**
   * Resolve the crosswalk record the other way round: `/pubs` keyed by the
   * journal DOI a preprint's `/details` record names. Answers for `10.64898/`
   * preprints, whose own DOI the path form never parses. The API reads only the
   * first two `/`-separated segments of the key, and its web server answers an
   * encoded slash (`%2F`) with a 404 — but the API decodes the key once more
   * itself, so every slash after the first is sent double-encoded (`%252F`) and
   * a journal DOI with a second slash (`10.1093/genetics/…`) still arrives
   * whole. Returns only the record for `preprintDoi`, or undefined when none
   * names it.
   * Throws a retryable `rate_limited` error when the origin returns HTTP 429.
   */
  async getPublishedVersionByJournalDoi(
    journalDoi: string,
    preprintDoi: string,
    server: BiorxivServer,
    ctx: Context,
  ): Promise<PublishedVersion | undefined> {
    const [registrant = '', ...suffix] = journalDoi.split('/');
    const encodedDoi = `${encodeURIComponent(registrant)}/${suffix.map(encodeURIComponent).join('%252F')}`;
    const wanted = preprintDoi.toLowerCase();
    const records = await this.fetchCrosswalk(
      encodedDoi,
      server,
      'getPublishedVersionByJournalDoi',
      ctx,
    );
    const record = records.find((r) => r.preprint_doi?.toLowerCase() === wanted);
    return record ? normalizePublished(record) : undefined;
  }

  /** Fetch the raw `/pubs/{server}/{key}` collection, keyed by an already path-encoded DOI. */
  private async fetchCrosswalk(
    encodedKey: string,
    server: BiorxivServer,
    operation: string,
    ctx: Context,
  ): Promise<RawPublishedRecord[]> {
    const url = `${this.baseUrl}/pubs/${server}/${encodedKey}/json`;
    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, 15_000, ctx, {
            signal: ctx.signal,
            headers: { 'User-Agent': this.userAgent },
            expectedStatuses: EXPECTED_STATUSES,
          });
          const text = await response.text();
          if (detectHtmlError(text)) {
            throw serviceUnavailable(
              'api.biorxiv.org returned HTML — likely rate-limited or down.',
              { url },
            );
          }
          return (JSON.parse(text) as RawPublishedResponse).collection ?? [];
        },
        {
          operation: `BiorxivApiService.${operation}`,
          context: ctx,
          baseDelayMs: 500,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      rethrowClassified(err);
    }
  }
}

// ─── Init / accessor ─────────────────────────────────────────────────────────

let _service: BiorxivApiService | undefined;

export function initBiorxivApiService(config: AppConfig, storage: StorageService): void {
  _service = new BiorxivApiService(config, storage);
}

export function getBiorxivApiService(): BiorxivApiService {
  if (!_service)
    throw new Error('BiorxivApiService not initialized — call initBiorxivApiService() in setup()');
  return _service;
}
