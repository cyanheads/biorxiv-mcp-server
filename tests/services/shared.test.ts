/**
 * @fileoverview Tests for shared service utilities — detectHtmlError,
 * SERVER_VERSION, normalizeUpstreamText, parseRetryAfterSeconds, and
 * findRateLimit.
 * @module tests/services/shared.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  detectHtmlError,
  findRateLimit,
  normalizeUpstreamText,
  parseRetryAfterSeconds,
  SERVER_VERSION,
} from '@/services/shared.js';
import packageJson from '../../package.json' with { type: 'json' };
import { rateLimitError } from '../helpers/rate-limit.js';

describe('detectHtmlError', () => {
  // ── True cases ──────────────────────────────────────────────────────────────

  it('detects <!DOCTYPE html> header (uppercase)', () => {
    expect(detectHtmlError('<!DOCTYPE html><html>')).toBe(true);
  });

  it('detects <!DOCTYPE HTML> header (mixed case)', () => {
    expect(detectHtmlError('<!DOCTYPE HTML><html>')).toBe(true);
  });

  it('detects <html> tag at start', () => {
    expect(detectHtmlError('<html><body>Error</body></html>')).toBe(true);
  });

  it('detects <html > with trailing space', () => {
    expect(detectHtmlError('<html ><body>Rate limited</body></html>')).toBe(true);
  });

  it('detects HTML after leading whitespace', () => {
    expect(detectHtmlError('  \n<!DOCTYPE html>\n<html>')).toBe(true);
  });

  it('detects <HTML> (uppercase tag)', () => {
    expect(detectHtmlError('<HTML><body></body></HTML>')).toBe(true);
  });

  // ── False cases ─────────────────────────────────────────────────────────────

  it('returns false for valid JSON object', () => {
    expect(detectHtmlError('{"collection":[]}')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(detectHtmlError('')).toBe(false);
  });

  it('returns false for plain text error message', () => {
    expect(detectHtmlError('Not Found')).toBe(false);
  });

  it('returns false for JSON containing an html key', () => {
    expect(detectHtmlError('{"html":"<b>text</b>"}')).toBe(false);
  });

  it('returns false for JSON with html mentioned in a string value', () => {
    expect(detectHtmlError('{"message":"see <html> docs"}')).toBe(false);
  });

  it('returns false for XML that is not an HTML page', () => {
    expect(detectHtmlError('<?xml version="1.0"?><collection/>')).toBe(false);
  });
});

describe('SERVER_VERSION', () => {
  it('is a non-empty semver string', () => {
    expect(typeof SERVER_VERSION).toBe('string');
    expect(SERVER_VERSION.length).toBeGreaterThan(0);
    // Basic semver format: major.minor.patch
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is derived from package.json, not hardcoded (guards against version drift)', () => {
    expect(SERVER_VERSION).toBe(packageJson.version);
  });
});

describe('normalizeUpstreamText', () => {
  it('strips the encoded small-caps "Abstract" heading fused to the body text', () => {
    // Live shape from 10.1101/2023.09.16.558066: the heading has no separating space.
    const raw = 'AO_SCPLOWBSTRACTC_SCPLOWLiving in groups offers social animals collective wisdom.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Living in groups offers social animals collective wisdom.',
    );
  });

  it('removes an entire figure block and all its export boilerplate', () => {
    // Live shape from 10.1101/2024.01.06.595824 (figure block sits at the end).
    const raw =
      'Sperm cryopreservation is the main approach. O_FIG O_LINKSMALLFIG WIDTH=200 HEIGHT=182 SRC="FIGDIR/small/595824v2_ufig1.gif" ALT="Figure 1">View larger version (47K):org.highwire.dtl.DTLVardef@130b9eeorg.highwire.dtl.DTLVardef@1fec841_HPS_FORMAT_FIGEXP  M_FIG C_FIG';
    const out = normalizeUpstreamText(raw);
    expect(out).toBe('Sperm cryopreservation is the main approach.');
    expect(out).not.toMatch(/O_FIG|C_FIG|SRC=|org\.highwire|DTLVardef|Graphical Abstract/);
  });

  it('strips inline HTML tags and collapses the whitespace they leave behind', () => {
    // Live shape from an EuropePMC title (note the double space before <i>).
    const raw = 'Synergistic CRISPR-Cas Antimicrobials in  <i>Staphylococcus aureus</i>';
    expect(normalizeUpstreamText(raw)).toBe(
      'Synergistic CRISPR-Cas Antimicrobials in Staphylococcus aureus',
    );
  });

  it('strips the full family of JATS formatting tags (b, sub, sup, u)', () => {
    const raw =
      'Expression of <b>TP53</b> and CO<sub>2</sub> with <sup>13</sup>C and <u>underlined</u>';
    expect(normalizeUpstreamText(raw)).toBe('Expression of TP53 and CO2 with 13C and underlined');
  });

  it('drops small-caps markers around inline text but keeps the wrapped content', () => {
    expect(normalizeUpstreamText('the O_SCPLOWlacZC_SCPLOW reporter gene')).toBe(
      'the lacZ reporter gene',
    );
  });

  it('leaves clean scientific text unchanged', () => {
    const clean = 'We show that rational agents maximise long-term rewards over short horizons.';
    expect(normalizeUpstreamText(clean)).toBe(clean);
  });

  it('does not eat mathematical inequalities that are not real HTML tags', () => {
    const raw = 'genes retained where the threshold was set at p<0.01 across all comparisons';
    expect(normalizeUpstreamText(raw)).toBe(raw);
  });

  it('returns undefined for absent input so callers keep treating fields as absent', () => {
    expect(normalizeUpstreamText(undefined)).toBeUndefined();
  });

  it('returns undefined when input reduces to nothing after stripping', () => {
    expect(normalizeUpstreamText('   ')).toBeUndefined();
    expect(normalizeUpstreamText('O_FIG SRC="x.gif" C_FIG')).toBeUndefined();
  });
});

describe('parseRetryAfterSeconds', () => {
  it('reads the RFC 9110 delta-seconds form as a whole-second wait', () => {
    expect(parseRetryAfterSeconds('94')).toBe(94);
    expect(parseRetryAfterSeconds('  30  ')).toBe(30);
    expect(parseRetryAfterSeconds('0')).toBe(0);
  });

  it('converts the RFC 9110 HTTP-date form to a wait from now', () => {
    const twoMinutesOut = new Date(Date.now() + 120_000).toUTCString();
    const seconds = parseRetryAfterSeconds(twoMinutesOut);
    expect(seconds).toBeGreaterThan(110);
    expect(seconds).toBeLessThanOrEqual(120);
  });

  it('clamps an HTTP-date already in the past to zero rather than a negative wait', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(past)).toBe(0);
  });

  it('returns undefined for an unparseable or absent value so callers word it generically', () => {
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    expect(parseRetryAfterSeconds(94)).toBeUndefined();
  });
});

describe('findRateLimit', () => {
  it('returns the wait when a rejection was classified as a rate limit', () => {
    expect(findRateLimit([rateLimitError(30)])).toEqual({ retryAfter: 30 });
  });

  it('returns an empty object when the rate limit carried no usable Retry-After', () => {
    expect(findRateLimit([rateLimitError()])).toEqual({});
  });

  it('takes the longest wait so a retry does not land inside the other origin limit', () => {
    expect(findRateLimit([rateLimitError(15), rateLimitError(90)])).toEqual({ retryAfter: 90 });
  });

  it('finds a rate limit mixed in with unrelated failures', () => {
    expect(findRateLimit([new Error('ECONNREFUSED'), rateLimitError(45)])).toEqual({
      retryAfter: 45,
    });
  });

  it('returns undefined when no rejection was a rate limit', () => {
    const other = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down', {
      reason: 'upstream_unavailable',
    });
    expect(findRateLimit([new Error('network error'), other])).toBeUndefined();
    expect(findRateLimit([])).toBeUndefined();
  });

  it('ignores a bare RateLimited error that this server did not classify itself', () => {
    // No `reason` marker — the framework's own status mapping, not our contract.
    const bare = new McpError(JsonRpcErrorCode.RateLimited, 'Status: 429', { status: 429 });
    expect(findRateLimit([bare])).toBeUndefined();
  });
});
