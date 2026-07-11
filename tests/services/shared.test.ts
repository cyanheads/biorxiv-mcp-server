/**
 * @fileoverview Tests for shared service utilities — detectHtmlError and SERVER_VERSION.
 * @module tests/services/shared.test
 */

import { describe, expect, it } from 'vitest';
import { detectHtmlError, SERVER_VERSION } from '@/services/shared.js';
import packageJson from '../../package.json' with { type: 'json' };

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
