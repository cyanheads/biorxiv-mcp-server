/**
 * @fileoverview Upstream text fixtures carrying Markdown metacharacters, with
 * the escaped form each tool's `format()` must render and identifiers that must
 * pass through untouched. Values mirror live bioRxiv/medRxiv records.
 * @module tests/helpers/markdown-fixtures
 */

/** Upstream free-text fields, exactly as `structuredContent` must carry them. */
export const UPSTREAM = {
  title: 'CYP2C19 *2/*35 carriers and F_{e} forces',
  abstract:
    '1. Adenine base editors enable efficient A*T to G*C conversion (p<0.05) under dim (~10 lux) and bright (~1500 lux) light, [IQR 3559-8950](P=0.01), via /api/stereoisomers/<COMP id> and `ggrain`.',
  authors: 'O`Toole, P.; Mu_ller, M.',
  authorCorresponding: 'Mary O`Toole',
  authorCorrespondingInstitution: 'Institute *for* Molecular_Biology',
  // Live award values: a leading `#` that opens no heading, a value upstream
  // already backslash-escaped, and intraword underscores.
  awards: ['#441914366', 'RP\\_018\\_20230628', 'UK Program MC_UU_00030/7'] as string[],
  category: 'hiv aids',
  license: 'cc_by_nc_nd',
  type: 'new results',
  journal: 'Journal of *Applied* Biomaterials',
} as const;

/**
 * The same fields escaped for `content[]`, so each renders literally — with a
 * backslash only where the character would otherwise change rendering, so the
 * intraword `_` and the `<` before a digit stay raw.
 */
export const ESCAPED = {
  title: 'CYP2C19 \\*2/\\*35 carriers and F\\_{e} forces',
  abstract:
    '1\\. Adenine base editors enable efficient A\\*T to G\\*C conversion (p<0.05) under dim (\\~10 lux) and bright (\\~1500 lux) light, \\[IQR 3559-8950](P=0.01), via /api/stereoisomers/\\<COMP id> and \\`ggrain\\`.',
  authors: 'O\\`Toole, P.; Mu_ller, M.',
  authorCorresponding: 'Mary O\\`Toole',
  authorCorrespondingInstitution: 'Institute \\*for\\* Molecular_Biology',
  /** `UPSTREAM.awards` as rendered: joined with `; `, only the upstream backslashes escaped. */
  awards: '#441914366; RP\\\\\\_018\\\\\\_20230628; UK Program MC_UU_00030/7',
  category: 'hiv aids',
  license: 'cc_by_nc_nd',
  type: 'new results',
  journal: 'Journal of \\*Applied\\* Biomaterials',
} as const;

/** Identifiers an agent copies back into calls — never escaped. */
export const IDENTIFIERS = {
  doi: '10.64898/2026.07.03.736350',
  jatsxmlUrl: 'https://www.biorxiv.org/content/early/2026/07/03/2026.07.03.736350_v1.source.xml',
  // A real Wiley SICI DOI: `<`, `(`, `)`, and `;` are all part of the identifier.
  publishedDoi: '10.1002/(SICI)1097-4636(199706)35:4<419::AID-JBM1>3.0.CO;2-L',
} as const;
