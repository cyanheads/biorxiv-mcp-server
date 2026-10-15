/**
 * @fileoverview Trimmed bioRxiv/medRxiv article pages for full-text extraction
 * tests, kept as HTML under `tests/fixtures/highwire/`. Each is an excerpt of a
 * captured Highwire page — a few paragraphs, the table blocks, and a handful of
 * reference entries — with the markup copied verbatim: `a.xref-bibr` /
 * `a.xref-fig` / `a.xref-table` labels (parenthesized, italic, and superscript),
 * `div.ref-list` entries with `div.cit-metadata` and `.cit-extra` link-outs, and
 * the `div.table` caption + `table-expand-popup` block that stands in for a
 * table's cells. Each fixture lists what extraction must keep, so a test can
 * assert every reference and label rather than a sample.
 * @module tests/helpers/highwire-fixtures
 */

import { readFileSync } from 'node:fs';

/** One trimmed article page and the facts extraction must preserve from it. */
export interface HighwireFixture {
  doi: string;
  html: string;
  /** Every inline citation, figure, and table label, as the page prints it in context. */
  labels: string[];
  /** DOIs the reference link-outs carry. */
  referenceDois: string[];
  /** The title of every reference entry in the fixture's reference list. */
  referenceTitles: string[];
  server: 'biorxiv' | 'medrxiv';
  /** The article page the HTML was captured from. */
  sourceUrl: string;
  /** Tables the page names without cells, with the absolute popup URL of each. */
  tables: { label: string; url: string }[];
  version: string;
}

const load = (name: string): string =>
  readFileSync(new URL(`../fixtures/highwire/${name}`, import.meta.url), 'utf8');

const popup = (host: string, id: string) =>
  `https://www.${host}.org/highwire/markup/${id}/expansion?width=1000&height=500&iframe=true&postprocessors=highwire_tables%2Chighwire_reclass%2Chighwire_figures%2Chighwire_math%2Chighwire_inline_linked_media%2Chighwire_embed`;

/** bioRxiv 10.1101/2020.03.30.015347 v1 — italic parenthesized numeric citations and one table. */
export const BIORXIV_015347: HighwireFixture = {
  server: 'biorxiv',
  doi: '10.1101/2020.03.30.015347',
  version: '1',
  sourceUrl: 'https://www.biorxiv.org/content/10.1101/2020.03.30.015347v1.full',
  html: load('biorxiv-015347v1.html'),
  referenceTitles: [
    'SARS-CoV-2 Viral Load in Upper Respiratory Specimens of Infected Patients',
    'A Novel Coronavirus from Patients with Pneumonia in China, 2019',
    'A pneumonia outbreak associated with a new coronavirus of probable bat origin',
    'Genomic characterization of the 2019 novel human-pathogenic coronavirus',
    'The species Severe acute respiratory syndrome-related coronavirus',
  ],
  labels: [
    '(*1–16*)',
    '(*17*)',
    '(*18*)',
    '(*20–26*)',
    '(Fig. 1A, B)',
    '(Fig. 1C, D)',
    '(Table 1)',
  ],
  tables: [{ label: 'Table 1', url: popup('biorxiv', '1231680') }],
  referenceDois: [
    '10.1056/NEJMoa2001017',
    '10.1038/s41586-020-2012-7',
    '10.1080/22221751.2020.1719902',
  ],
};

/** bioRxiv 10.1101/2024.05.28.596311 v1 — superscript numeric citations, figure labels, no tables. */
export const BIORXIV_596311: HighwireFixture = {
  server: 'biorxiv',
  doi: '10.1101/2024.05.28.596311',
  version: '1',
  sourceUrl: 'https://www.biorxiv.org/content/10.1101/2024.05.28.596311v1.full',
  html: load('biorxiv-596311v1.html'),
  referenceTitles: [
    'Callosotomy patients exhibit temporal uncoupling during continuous bimanual movements',
    'Haptic object localization in the vibrissal system: behavior and performance',
    'A rare case of deafferentation reveals an essential role of proprioception',
    'Bimanual Coordination During Rhythmic Movements in the Absence of Somatosensory Feedback',
  ],
  labels: [
    '<sup>1–4</sup>',
    '<sup>5</sup>',
    '<sup>6–8</sup>',
    '<sup>9–11</sup>',
    '<sup>12</sup>',
    '<sup>1,13–16</sup>',
    '<sup>17</sup>',
    '(Fig. 1 and Suppl. Fig. 1)',
    '(Fig. 1a)',
    'whisker pairs (Fig. 1b)',
    'both bilateral pairs of whiskers (Fig. 1b)',
    'Fig. 1a, c & Suppl. Video 1)',
    '<sup>39</sup>',
    '(Fig. 1d and Suppl. Fig. 1c)',
  ],
  tables: [],
  referenceDois: ['10.1038/nn822', '10.1152/jn.00363.2005'],
};

/** medRxiv 10.1101/2020.04.14.20062463 v1 — superscript citations, web references, two tables. */
export const MEDRXIV_20062463: HighwireFixture = {
  server: 'medrxiv',
  doi: '10.1101/2020.04.14.20062463',
  version: '1',
  sourceUrl: 'https://www.medrxiv.org/content/10.1101/2020.04.14.20062463v1.full',
  html: load('medrxiv-20062463v1.html'),
  referenceTitles: [
    'Novel Coronavirus Press Archives - Public Health Department - County of Santa Clara',
    'Report 12 - The global impact of COVID-19 and strategies for mitigation and suppression',
    'Estimating case fatality rates of COVID-19',
  ],
  labels: ['2020.<sup>1</sup>', 'deaths.<sup>2</sup>'],
  tables: [
    { label: 'Table 1', url: popup('medrxiv', '160719') },
    { label: 'Table 2', url: popup('medrxiv', '160732') },
  ],
  referenceDois: [],
};

/**
 * {@link BIORXIV_015347} with its numeric citation anchors relabelled
 * author-year — the label variant other bioRxiv articles print, carried by the
 * same `a.xref-bibr` markup. Labels are numbered by position so each one is
 * distinct.
 */
export function authorYearVariant(): HighwireFixture & { authorYearLabels: string[] } {
  let n = 0;
  const authorYearLabels: string[] = [];
  const html = BIORXIV_015347.html.replace(
    /(<a [^>]*class="xref-bibr"[^>]*>)[^<]*(<\/a>)/g,
    (_match, open: string, close: string) => {
      const label = `Author${++n} et al., 20${10 + (n % 10)}`;
      authorYearLabels.push(label);
      return `${open}${label}${close}`;
    },
  );
  return { ...BIORXIV_015347, html, labels: [], authorYearLabels };
}

/** Every fixture page, for assertions that hold on all of them. */
export const HIGHWIRE_FIXTURES = [BIORXIV_015347, BIORXIV_596311, MEDRXIV_20062463];
