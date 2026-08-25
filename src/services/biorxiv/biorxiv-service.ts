/**
 * @fileoverview BiorxivApiService — wraps api.biorxiv.org endpoints for
 * preprint details (/details), date-range listing (/details with date interval),
 * and crosswalk (/pubs). All methods retry with exponential backoff. Parses
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
  RawPublishedResponse,
} from './types.js';

// ─── Hardcoded category taxonomy ─────────────────────────────────────────────
// No API endpoint provides this; it changes infrequently. Maintained here.
const CATEGORIES: CategoryTaxonomy = {
  biorxiv: [
    'Animal Behavior and Cognition',
    'Biochemistry',
    'Bioengineering',
    'Bioinformatics',
    'Biophysics',
    'Cancer Biology',
    'Cell Biology',
    'Clinical Trials',
    'Developmental Biology',
    'Ecology',
    'Epidemiology',
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
    'Vascular Medicine',
  ],
};

// Pre-built sets for O(1) category membership checks
const BIORXIV_CATEGORIES = new Set(CATEGORIES.biorxiv);
const MEDRXIV_CATEGORIES = new Set(CATEGORIES.medrxiv);
const ALL_CATEGORIES = new Set([...CATEGORIES.biorxiv, ...CATEGORIES.medrxiv]);

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
   * When server is 'both', the category must exist in at least one server's taxonomy.
   * Use isValidCategoryForServer() to check per-server membership.
   */
  isValidCategory(category: string, server: BiorxivServer | 'both' = 'both'): boolean {
    if (server === 'both') return ALL_CATEGORIES.has(category);
    return (server === 'biorxiv' ? BIORXIV_CATEGORIES : MEDRXIV_CATEGORIES).has(category);
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
   * Returns listing result with pagination state.
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
      url += `?category=${encodeURIComponent(category)}`;
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
          return {
            preprints,
            pagination: { cursor, total },
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
   * Returns undefined when the preprint is not yet published.
   * Throws a retryable `rate_limited` error when the origin returns HTTP 429.
   */
  async getPublishedVersion(
    doi: string,
    server: BiorxivServer,
    ctx: Context,
  ): Promise<PublishedVersion | undefined> {
    const encodedDoi = doi.split('/').map(encodeURIComponent).join('/');
    const url = `${this.baseUrl}/pubs/${server}/${encodedDoi}/json`;
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
          const data = JSON.parse(text) as RawPublishedResponse;
          const record = data.collection?.[0];
          if (!record?.preprint_doi) return;
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
            pv.preprintAuthorCorrespondingInstitution =
              record.preprint_author_corresponding_institution;
          return pv;
        },
        {
          operation: 'BiorxivApiService.getPublishedVersion',
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
