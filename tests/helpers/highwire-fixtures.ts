/**
 * @fileoverview Trimmed bioRxiv/medRxiv article pages for full-text extraction
 * tests, kept as HTML under `tests/fixtures/highwire/`. Each is an excerpt of a
 * captured Highwire page — a few paragraphs, figure and table blocks, and a
 * handful of reference entries — with the markup copied verbatim: `a.xref-bibr`
 * / `a.xref-fig` / `a.xref-table` labels (parenthesized, italic, and
 * superscript), `div.fig` blocks whose image link and image repeat the caption
 * in `title` and `alt`, `div.ref-list` entries with `span.ref-label`,
 * `div.cit-metadata`, and `.cit-extra` link-outs, the `div.table` caption +
 * `table-expand-popup` block that stands in for a table's cells, and
 * `span.disp-formula` images set inside paragraphs, a short subsection headed
 * with a word Defuddle reads as navigation, and a reference entry that repeats
 * its editors in an `ol.duplicate` list. Each fixture lists what
 * extraction must keep, so a test can assert every reference, label, figure,
 * and formula rather than a sample.
 * @module tests/helpers/highwire-fixtures
 */

import { readFileSync } from 'node:fs';

/** One figure image and how it must render. */
export interface FixtureFigure {
  /** The image's alt text: the figure's printed label, without trailing punctuation. */
  alt: string;
  /** A phrase of the figure's caption, which the Markdown must carry exactly once. Absent for a figure that prints no caption. */
  caption?: string;
  src: string;
}

/** One trimmed article page and the facts extraction must preserve from it. */
export interface HighwireFixture {
  doi: string;
  /** Every figure image on the page, in page order. */
  figures: FixtureFigure[];
  /** The image URL of every display formula on the page, in page order. */
  formulas: string[];
  html: string;
  /** Every inline citation, figure, and table label, as the page prints it in context. */
  labels: string[];
  /** DOIs the reference link-outs carry. */
  referenceDois: string[];
  /**
   * How each reference entry opens in the Markdown, in page order: the list's
   * own number when the printed labels count up one by one, otherwise a bullet
   * and the printed label.
   */
  referenceMarkers: string[];
  /** The title of every reference entry in the fixture's reference lists. */
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

/**
 * bioRxiv 10.1101/2020.03.30.015347 v1 — italic parenthesized numeric citations,
 * one table, two figures whose image-link titles hold no `)`, and a reference
 * excerpt labelled 1–3, 16, 17.
 */
export const BIORXIV_015347: HighwireFixture = {
  server: 'biorxiv',
  doi: '10.1101/2020.03.30.015347',
  version: '1',
  sourceUrl: 'https://www.biorxiv.org/content/10.1101/2020.03.30.015347v1.full',
  html: load('biorxiv-015347v1.html'),
  formulas: [],
  figures: [
    {
      alt: 'Figure S2',
      src: 'https://www.biorxiv.org/content/biorxiv/early/2020/03/31/2020.03.30.015347/F5.medium.gif',
      caption: 'Ferrets inoculated with F13-E virus or CTan-H virus were euthanized on day 13 p.i.',
    },
    {
      alt: 'Figure S4',
      src: 'https://www.biorxiv.org/content/biorxiv/early/2020/03/31/2020.03.30.015347/F7.medium.gif',
      caption: 'Eight ferrets were inoculated intratracheally with 10<sup>5</sup> PFU of CTan-H.',
    },
  ],
  referenceMarkers: ['- 1.', '- 2.', '- 3.', '- 16.', '- 17.'],
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
  formulas: [],
  figures: [],
  referenceMarkers: ['1.', '2.', '3.', '4.'],
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
  formulas: [],
  figures: [],
  referenceMarkers: ['1.', '2.', '3.'],
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
 * bioRxiv 10.1101/2024.12.06.627082 v3 — figures whose image-link titles hold
 * `)` and `>`, a figure under its own section heading, and a Methods reference
 * list labelled from 53.
 */
export const BIORXIV_627082: HighwireFixture = {
  server: 'biorxiv',
  doi: '10.1101/2024.12.06.627082',
  version: '3',
  sourceUrl: 'https://www.biorxiv.org/content/10.1101/2024.12.06.627082v3.full',
  html: load('biorxiv-627082v3.html'),
  formulas: [],
  figures: [
    {
      alt: 'Figure 1',
      src: 'https://www.biorxiv.org/content/biorxiv/early/2026/09/30/2024.12.06.627082/F1.medium.gif',
      caption: 'Fire perimeters contained >10% forest in the year before burn.',
    },
    {
      alt: 'Figure 2',
      src: 'https://www.biorxiv.org/content/biorxiv/early/2026/09/30/2024.12.06.627082/F2.medium.gif',
      caption: 'by state and year, compared with the total forest area that burned',
    },
    {
      alt: 'Supplementary Figure 1',
      src: 'https://www.biorxiv.org/content/biorxiv/early/2026/09/30/2024.12.06.627082/F6.medium.gif',
      caption: 'occurring with >0.1 bc-CBI.',
    },
  ],
  labels: ['(Figure 1)', '(Figure 2)', '(26)', '(Figure 3A)', '(Figure 3B)', '(Figure 3C)'],
  tables: [],
  referenceDois: ['10.1073/pnas.2208120120', '10.1002/fee.1311', '10.1016/j.rse.2019.111356'],
  referenceMarkers: ['1.', '2.', '3.', '53.', '54.', '55.'],
  referenceTitles: [
    'Reduced fire severity offers near-term buffer to climate-driven declines in conifer resilience across the western United States',
    'Effects of Wildfire on Soils and Watershed Processes',
    'Changing disturbance regimes, ecological memory, and forest resilience',
    'A Project for Monitoring Trends in Burn Severity',
    'Landscape Change Monitoring System (LCMS)',
    'Lessons learned implementing an operational continuous United States national land change monitoring capability: The Land Change Monitoring, Assessment, and Projection (LCMAP) approach',
  ],
};

/**
 * bioRxiv 10.64898/2026.07.03.736350 v1 — a figure between two paragraphs that
 * cite it, and references labelled `(1).`.
 */
export const BIORXIV_736350: HighwireFixture = {
  server: 'biorxiv',
  doi: '10.64898/2026.07.03.736350',
  version: '1',
  sourceUrl: 'https://www.biorxiv.org/content/10.64898/2026.07.03.736350v1.full',
  html: load('biorxiv-736350v1.html'),
  formulas: [],
  figures: [
    {
      alt: 'Figure 2',
      src: 'https://www.biorxiv.org/content/biorxiv/early/2026/07/03/2026.07.03.736350/F2.medium.gif',
      caption: 'Live-cell fluorescence microscopy of HEK293T cells',
    },
  ],
  labels: ['(Figure 2A)', '(Figure 2B)', '(Figure 2C)'],
  tables: [],
  referenceDois: [
    '10.1371/journal.pbio.3002071',
    '10.1038/nature24644',
    '10.1038/s41587-020-0491-6',
  ],
  referenceMarkers: ['1.', '2.', '3.'],
  referenceTitles: [
    'In the Business of Base Editors: Evolution from Bench to Bedside',
    'Programmable Base Editing of A•T to G•C in Genomic DNA without DNA Cleavage',
    'Directed Evolution of Adenine Base Editors with Increased Activity and Therapeutic Application',
  ],
};

/**
 * medRxiv 10.64898/2026.08.27.26361515 v1 — a figure labelled `Figure 1:` whose
 * image-link title holds no `)`, a figure that prints no label or caption,
 * display formulas set inside paragraphs (one with text after it, two in one
 * paragraph), and references labelled `[1].`.
 */
export const MEDRXIV_26361515: HighwireFixture = {
  server: 'medrxiv',
  doi: '10.64898/2026.08.27.26361515',
  version: '1',
  sourceUrl: 'https://www.medrxiv.org/content/10.64898/2026.08.27.26361515v1.full',
  html: load('medrxiv-26361515v1.html'),
  figures: [
    {
      alt: 'Figure 1',
      src: 'https://www.medrxiv.org/content/medrxiv/early/2026/09/01/2026.08.27.26361515/F1.medium.gif',
      caption: 'ULEZ Expansion Map by Stage',
    },
    {
      alt: '',
      src: 'https://www.medrxiv.org/content/medrxiv/early/2026/09/01/2026.08.27.26361515/F2.medium.gif',
    },
  ],
  formulas: [3, 23, 24].map(
    (n) =>
      `https://www.medrxiv.org/sites/default/files/highwire/medrxiv/early/2026/09/01/2026.08.27.26361515/embed/graphic-${n}.gif`,
  ),
  labels: ['Figure 1 shows', 'matrix completion \\[20\\]'],
  tables: [],
  referenceDois: ['10.1289/EHP11506', '10.2174/1381612822666151109111712'],
  referenceMarkers: ['1.', '2.', '3.'],
  referenceTitles: [
    'Effect of Air Pollution on Heart Failure: Systematic Review and Meta-Analysis',
    'Air Pollution Exposure and Blood Pressure: An Updated Review of the Literature',
    'Air Pollution Deaths Attributable to Fossil Fuels: Observational and Modelling Study',
  ],
};

/** medRxiv 10.64898/2026.08.27.26361261 v1 — Fig. S16, one figure holding two images. */
export const MEDRXIV_26361261: HighwireFixture = {
  server: 'medrxiv',
  doi: '10.64898/2026.08.27.26361261',
  version: '1',
  sourceUrl: 'https://www.medrxiv.org/content/10.64898/2026.08.27.26361261v1.full',
  html: load('medrxiv-26361261v1.html'),
  formulas: [],
  figures: [
    {
      alt: 'Fig. S16 (1 of 2)',
      src: 'https://www.medrxiv.org/content/medrxiv/early/2026/09/01/2026.08.27.26361261/F20/graphic-23.medium.gif',
      caption: 'Cytokine concentrations in CSF are shown',
    },
    {
      alt: 'Fig. S16 (2 of 2)',
      src: 'https://www.medrxiv.org/content/medrxiv/early/2026/09/01/2026.08.27.26361261/F20/graphic-24.medium.gif',
      caption: 'Cytokine concentrations in CSF are shown',
    },
  ],
  labels: [],
  tables: [],
  referenceDois: [],
  referenceMarkers: [],
  referenceTitles: [],
};

/**
 * medRxiv 10.64898/2026.10.13.26365491 v1 — a Results section whose subsection
 * `3.2 Effect of suppressing the vaccination-related input` runs under 200 words
 * with a figure, between two trimmed subsections, and references labelled `[1].`.
 */
export const MEDRXIV_26365491: HighwireFixture = {
  server: 'medrxiv',
  doi: '10.64898/2026.10.13.26365491',
  version: '1',
  sourceUrl: 'https://www.medrxiv.org/content/10.64898/2026.10.13.26365491v1.full',
  html: load('medrxiv-26365491v1.html'),
  formulas: [],
  figures: [
    {
      alt: 'Figure 3',
      src: 'https://www.medrxiv.org/content/medrxiv/early/2026/10/14/2026.10.13.26365491/F3.medium.gif',
      caption: 'after suppression of the vaccination-related input (solid line).',
    },
  ],
  labels: [
    'shown in Table 1 (which',
    'presented in Figure 2.',
    'Figure 3 shows',
    'listed in Table 1. Despite',
    'Figure 4 shows',
    'FDH (Figure 4(a))',
  ],
  tables: [],
  referenceDois: ['10.1038/s41598-023-44942-6'],
  referenceMarkers: ['1.', '2.'],
  referenceTitles: [
    'Mathematical Models in Epidemiology',
    'Evaluating the COVID-19 vaccination program in Japan, 2021 using the counterfactual reproduction number',
  ],
};

/**
 * bioRxiv 10.1101/336701 v1 — one paragraph whose subscripts carry an escaped
 * `<` (`<sub>&lt;50x</sub>`), which must reach the Markdown still escaped.
 */
export const BIORXIV_336701: HighwireFixture = {
  server: 'biorxiv',
  doi: '10.1101/336701',
  version: '1',
  sourceUrl: 'https://www.biorxiv.org/content/10.1101/336701v1.full',
  html: load('biorxiv-336701v1.html'),
  formulas: [],
  figures: [],
  labels: [],
  tables: [],
  referenceDois: [],
  referenceMarkers: [],
  referenceTitles: [],
};

/**
 * bioRxiv 10.64898/2026.07.03.736286 v2 — references labelled 6–8, where entry 7
 * names its editors twice: in an `ol.duplicate` ahead of the citation, and in the
 * citation itself (`In A. Rich, and N. Davidson, editors`). Kept out of
 * {@link HIGHWIRE_FIXTURES}: extraction drops that duplicate list, so entry 7's
 * whole `div.cit-metadata` text does not reach the Markdown.
 */
export const BIORXIV_736286: HighwireFixture = {
  server: 'biorxiv',
  doi: '10.64898/2026.07.03.736286',
  version: '2',
  sourceUrl: 'https://www.biorxiv.org/content/10.64898/2026.07.03.736286v2.full',
  html: load('biorxiv-736286v2.html'),
  formulas: [],
  figures: [],
  labels: ['(1–3)', '(4–6)', '(7–9)', '(7)', '(10–14)', '(15)', '(10–12, 16)'],
  tables: [],
  referenceDois: ['10.1007/s12080-007-0001-1'],
  referenceMarkers: ['6.', '7.', '8.'],
  referenceTitles: [
    'Alternative stable states in host–phage dynamics',
    'Reduction of dimensionality in biological diffusion processes',
    'Accelerated Adsorption of Bacteriophage T5 to Escherichia coli F Resulting from Reversible Tail Fiber–Lipopolysaccharide Binding',
  ],
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

/**
 * An edited volume's two editors as a list nested in a reference entry, in
 * Highwire's citation markup. Synthetic, modeled on the reference entries of
 * these fixtures; {@link withEditorList} sets it ahead of the citation.
 */
export const EDITOR_LIST =
  '<ol class="cit-ed-list"><li><span class="cit-ed"><span class="cit-name-given-names">A.</span> <span class="cit-name-surname">Rich</span></span>, and</li><li><span class="cit-ed"><span class="cit-name-given-names">N.</span> <span class="cit-name-surname">Davidson</span></span></li></ol>';

/**
 * `fixture` with `list` opening the `div.cit-metadata` of the reference entry
 * labelled `label` (as printed, `55.`). Throws when the page has no such entry.
 */
export function withEditorList(
  fixture: HighwireFixture,
  label: string,
  list = EDITOR_LIST,
): HighwireFixture {
  const entry = fixture.html.indexOf(`<span class="ref-label">${label}</span>`);
  const open = '<div class="cit-metadata">';
  const at = entry < 0 ? -1 : fixture.html.indexOf(open, entry);
  if (at < 0) throw new Error(`No reference entry labelled ${label} in ${fixture.sourceUrl}`);
  const cut = at + open.length;
  return { ...fixture, html: fixture.html.slice(0, cut) + list + fixture.html.slice(cut) };
}

/**
 * Every fixture page with figures or references, for assertions that hold on
 * all of them. {@link BIORXIV_336701} stays out: its body escapes are the case
 * the figure-entity assertion must not reach.
 */
export const HIGHWIRE_FIXTURES = [
  BIORXIV_015347,
  BIORXIV_596311,
  MEDRXIV_20062463,
  BIORXIV_627082,
  BIORXIV_736350,
  MEDRXIV_26361515,
  MEDRXIV_26361261,
  MEDRXIV_26365491,
];
