/**
 * @fileoverview Tests for shared service utilities — detectHtmlError,
 * SERVER_VERSION, normalizeUpstreamText, normalizeDoi, normalizeRorId,
 * escapeMarkdown, parseRetryAfterSeconds, and findRateLimit.
 * @module tests/services/shared.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  detectHtmlError,
  escapeMarkdown,
  findRateLimit,
  normalizeDoi,
  normalizeRorId,
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
    // Live shape: 10.64898/2026.09.14.26363001 wraps the trailing `.` in the capital variant.
    expect(
      normalizeUpstreamText('Cohens O_SCPLOWKC_SCPLOWO_SCPCAP.C_SCPCAP Descriptor importance'),
    ).toBe('Cohens K. Descriptor importance');
  });

  it('turns an EuropePMC <h4> heading into "Heading: "', () => {
    // Live shape: EuropePMC core abstractText for 10.64898/2026.09.04.26361064.
    const raw =
      '<h4>Structured Abstract</h4>  <h4>Aims</h4>  To characterize adults with obesity. <h4>Methods:</h4>  We created a cohort.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Structured Abstract: Aims: To characterize adults with obesity. Methods: We created a cohort.',
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

  // ── Highwire symbol placeholders ────────────────────────────────────────────

  it.each([
    ['{beta}', 'β'],
    ['{+/-}', '±'],
    ['{degrees}', '°'],
    ['{gamma}', 'γ'],
    ['{Delta}', 'Δ'],
    ['{middle dot}', '·'],
    ['{micro}', 'µ'],
    ['{superscript 2}', '²'],
    ['{square}', '□'],
    ['{kappa}', 'κ'],
    ['{delta}', 'δ'],
    ['{rho}', 'ρ'],
    ['{approx}', '≈'],
    ['{varphi}', 'φ'],
    ['{varepsilon}', 'ε'],
    ['{omega}', 'ω'],
    ['{superscript 1}', '¹'],
    ['{tau}', 'τ'],
    ['{sigma}', 'σ'],
    ['{lambda}', 'λ'],
    ['{Psi}', 'Ψ'],
    ['{chi}', 'χ'],
    ['{pound}', '£'],
    ['{triangleup}', 'Δ'],
    ['{xi}', 'ξ'],
    ['{whitebullet}', '◦'],
    ['{Phi}', 'Φ'],
    ['{pi}', 'π'],
    ['{epsilon}', 'ϵ'],
    ['{o}', 'º'],
    ['{theta}', 'θ'],
    ['{Rightarrow}', '⇒'],
    ['{psi}', 'ψ'],
    ['{Omega}', 'Ω'],
    ['{zeta}', 'ζ'],
    ['{Gamma}', 'Γ'],
    ['{downarrow}', '↓'],
    ['{infty}', '∞'],
    ['{euro}', '€'],
    ['{Sigma}', 'Σ'],
    ['{gtrsim}', '≳'],
    ['{inverted exclamation}', '¡'],
    ['{Lambda}', 'Λ'],
    ['{cap}', '∩'],
    ['{uparrow}', '↑'],
    ['{paragraph}', '¶'],
    ['{nu}', 'ν'],
  ])('maps the brace placeholder %s to %s', (placeholder, glyph) => {
    expect(normalizeUpstreamText(`value ${placeholder} here`)).toBe(`value ${glyph} here`);
  });

  it('maps placeholders in their live contexts, adjacent ones included', () => {
    // Live shapes: 10.64898/2026.08.30.26361755, 10.1101/2025.11.03.686422, 10.1101/2025.11.02.686076.
    expect(normalizeUpstreamText('energy within {+/-}3% (Spearman {rho}=0.14)')).toBe(
      'energy within ±3% (Spearman ρ=0.14)',
    );
    expect(normalizeUpstreamText('nearly 1 t ha{square}{superscript 1} of yield')).toBe(
      'nearly 1 t ha□¹ of yield',
    );
    expect(normalizeUpstreamText('the association rate (k{square}{square})')).toBe(
      'the association rate (k□□)',
    );
    expect(normalizeUpstreamText('{Phi}Xacm4-11 phage')).toBe('ΦXacm4-11 phage');
  });

  it.each([
    ['[~]10 cell wide', '∼10 cell wide'],
    ['protein [&ge;]98% of baseline', 'protein ≥98% of baseline'],
    ['P [&le;] 0.05', 'P ≤ 0.05'],
    ['the N [-&gt;] {infty} limit', 'the N → ∞ limit'],
    ['x [isin] [R]N', 'x ∈ [R]N'],
    ['toward {nu} [~=] 0.74', 'toward ν ≃ 0.74'],
    ['{beta} = [-]0.42', 'β = ―0.42'],
    ['85 characters[bullet] Sensitivity', '85 characters• Sensitivity'],
    ['Key Points[tpltrtarr] Inwardly', 'Key Points➢ Inwardly'],
    ['TGF[beta] signaling', 'TGFβ signaling'],
    ['the ,[x1D05]-transpeptidase family', 'the ,ᴅ-transpeptidase family'],
  ])('maps the bracket placeholder in %j', (raw, expected) => {
    expect(normalizeUpstreamText(raw)).toBe(expected);
  });

  it('keeps an unknown placeholder name verbatim rather than deleting it', () => {
    expect(normalizeUpstreamText('a {frobnicate} and a {two words} and [zorp]')).toBe(
      'a {frobnicate} and a {two words} and [zorp]',
    );
  });

  it('keeps LaTeX braces verbatim after _, ^, \\command, or {', () => {
    // Live shapes from the 3 corpus records that carry LaTeX.
    const latex =
      'forces F_{e} and v_{0}, \\mathrm{F} and \\mathrm{EN}, \\sqrt{F_{e}^{2}+v_{0}^{2}}, d_{valley}, 19^{o}C, {{beta}}, {\\div v}';
    expect(normalizeUpstreamText(latex)).toBe(latex);
  });

  it('keeps set notation and non-placeholder brace content verbatim', () => {
    const raw = 'x in {0, 1} over {A, B, C}, the {C. Elegans} strain, {e} and {F}';
    expect(normalizeUpstreamText(raw)).toBe(raw);
  });

  it('keeps single-letter and ordinary bracketed tokens verbatim', () => {
    // [A] is Å and [a] is α in some records, but [A]/[E] are also concentration notation.
    const raw =
      'resolution of 2.35 [A], [E] > 0, [R]1 = -3.05, [a]-1,2-galactose, [O] (log N), [Ca2+], [18F]FDG, [CI], [m]RNA, [Formula], [mixed], [xyz1], (95% CI [-3.64, -2.46])';
    expect(normalizeUpstreamText(raw)).toBe(raw);
  });

  // ── Section headings ────────────────────────────────────────────────────────

  it('turns an O_ST_ABS heading into "Heading: "', () => {
    // Live shape: 10.64898/2026.08.30.26361755.
    expect(
      normalizeUpstreamText(
        'Structured abstractO_ST_ABSBackgroundC_ST_ABSPro-inflammatory diets threaten health.',
      ),
    ).toBe('Structured abstract Background: Pro-inflammatory diets threaten health.');
    expect(normalizeUpstreamText('AbstractO_ST_ABSAim:C_ST_ABSAvian malaria')).toBe(
      'Abstract Aim: Avian malaria',
    );
  });

  it('drops an unpaired or empty O_ST_ABS marker', () => {
    expect(normalizeUpstreamText('Intro O_ST_ABSC_ST_ABS text C_ST_ABS end')).toBe(
      'Intro text end',
    );
  });

  it('splits a paragraph-initial heading fused to its body after a line break', () => {
    // Live shape: every medRxiv structured abstract.
    const raw =
      'BackgroundDiets threaten health.\n\nMethodsFrom FAO Food Balance Sheets we built sDII.\n\nResultssDII was weakly associated.\n\nConclusionsAnti-inflammatory goals align.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Background: Diets threaten health. Methods: From FAO Food Balance Sheets we built sDII. Results: sDII was weakly associated. Conclusions: Anti-inflammatory goals align.',
    );
  });

  it('matches the closed heading list case-insensitively, longest heading first', () => {
    const raw =
      'Intro.\n\nSignificance StatementThe work matters.\nAuthor summaryWe show it.\nMethods and ResultsWe did it.\nMethodsA systematic search.\nResults50% of mice died.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Intro. Significance Statement: The work matters. Author summary: We show it. Methods and Results: We did it. Methods: A systematic search. Results: 50% of mice died.',
    );
  });

  it('gives a heading that sits alone on its line a colon', () => {
    expect(normalizeUpstreamText('Intro.\n\nResults\nInsulin-secreting cells expand.')).toBe(
      'Intro. Results: Insulin-secreting cells expand.',
    );
  });

  it('splits a heading fused to a lowercase-led token that carries a capital or digit', () => {
    // Live shapes: 10.64898/2026.08.30.26361755 (sDII) and corpus miRNA/iTBS abstracts.
    const raw =
      'Intro.\n\nResultssDII was weakly associated.\nConclusionsmiRNA signals persist.\nMethodsrfMRI data from 97 patients.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Intro. Results: sDII was weakly associated. Conclusions: miRNA signals persist. Methods: rfMRI data from 97 patients.',
    );
  });

  it('prefers the heading followed by a capital over a longer one followed by lowercase', () => {
    // `HighlightSbtA2` is the heading `Highlight` fused to the gene `SbtA2`.
    expect(normalizeUpstreamText('Intro.\n\nHighlightSbtA2 transporters are fast.')).toBe(
      'Intro. Highlight: SbtA2 transporters are fast.',
    );
  });

  it('keeps the capital that opens the body out of a longer heading', () => {
    // Live shapes: 10.1101/2023.03.07.23286875 (AimSGLT2) and 10.1101/2023.06.09.23291201
    // (ConclusionSARS-CoV-2) — `Aims`/`Conclusions` match too, but only by taking that capital.
    const raw =
      'Intro.\n\nAimSGLT2 inhibitors help.\nConclusionSARS-CoV-2 spread.\nAimsSCORE2 tables apply.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Intro. Aim: SGLT2 inhibitors help. Conclusion: SARS-CoV-2 spread. Aims: SCORE2 tables apply.',
    );
  });

  it('never splits a gene symbol that opens with the Aim heading before a digit', () => {
    // AIM1, AIM2, and mouse Aim2 are gene symbols; `Aim`/`Aims` never precede a digit as a heading.
    const raw = 'Intro.\n\nAIM2 is a cytosolic DNA sensor.\nAim2-deficient mice.\nAimTo test it.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Intro. AIM2 is a cytosolic DNA sensor. Aim2-deficient mice. Aim: To test it.',
    );
  });

  it('never splits a paragraph that opens with a CamelCase name', () => {
    const raw =
      'We benchmark tools.\n\nAlphaFold3 predicts the complex.\n\nChatGPT answered 40% of items.';
    expect(normalizeUpstreamText(raw)).toBe(
      'We benchmark tools. AlphaFold3 predicts the complex. ChatGPT answered 40% of items.',
    );
  });

  it('leaves a heading word that is already separated, not fused, not paragraph-initial, or lowercase alone', () => {
    const raw =
      'Intro.\n\nRESULTS: T and B cells were altered.\nResults were robust.\nAimed to test it.\nWe queried ResultsDB entries.\nresults Improved over time.';
    expect(normalizeUpstreamText(raw)).toBe(
      'Intro. RESULTS: T and B cells were altered. Results were robust. Aimed to test it. We queried ResultsDB entries. results Improved over time.',
    );
  });

  it('never splits a single-paragraph text such as a title', () => {
    expect(normalizeUpstreamText('DesignMaster: A Multi-Conditional Diffusion Framework')).toBe(
      'DesignMaster: A Multi-Conditional Diffusion Framework',
    );
  });

  // ── Lists and other Highwire blocks ─────────────────────────────────────────

  it('turns O_LI … C_LI list items into "• " items', () => {
    // Live shape: 10.64898/2026.08.30.26361755.
    const raw =
      'Goals align.\n\nKey messagesO_LIAt the country level, footprints are decoupled.\nC_LIO_LIA nutrition-feasible reallocation achieves synergy.\nC_LI';
    expect(normalizeUpstreamText(raw)).toBe(
      'Goals align. Key messages: • At the country level, footprints are decoupled. • A nutrition-feasible reallocation achieves synergy.',
    );
  });

  it('removes an O_FIG_DISPLAY block whole, leaving no _DISPLAY residue', () => {
    // Live shape: 10.1101/2020.04.14.040204.
    const raw =
      'thought to be cured, patients.\n\nGraphical Abstract O_FIG_DISPLAY_L [Figure 1] M_FIG_DISPLAY C_FIG_DISPLAY';
    expect(normalizeUpstreamText(raw)).toBe('thought to be cured, patients.');
  });

  it('removes an O_TBL … C_TBL table block whole, caption included', () => {
    const raw =
      'The Log is accessible.\n\nO_TBL View this table:\norg.highwire.dtl.DTLVardef@11e0d M_TBL O_FLOATNOTable 1.C_FLOATNO O_TABLECAPTIONAccuracy by siteC_TABLECAPTION C_TBL After the table.';
    expect(normalizeUpstreamText(raw)).toBe('The Log is accessible. After the table.');
  });

  it('drops O_TEXTBOX, O_FD, and O_INLINEFIG markers but keeps the text inside them', () => {
    expect(
      normalizeUpstreamText(
        'microbes.\n\nO_TEXTBOXSIGNIFICANCENatural products matter.\n\nC_TEXTBOX',
      ),
    ).toBe('microbes. SIGNIFICANCE: Natural products matter.');
    expect(
      normalizeUpstreamText(
        'a flow-inertia formulation: O_FD O_INLINEFIG[Formula 1]C_INLINEFIGM_FD(1)C_FD where S denotes',
      ),
    ).toBe('a flow-inertia formulation: [Formula 1] (1) where S denotes');
  });

  it('emits no Markdown syntax of its own and leaves upstream * untouched', () => {
    // `A*T` may be a lost `•` (EuropePMC has A•T), but the normalizer cannot know that.
    const out = normalizeUpstreamText(
      'Key messagesO_LIAt the base.\nC_LIO_LIA*T to G*C.\nC_LI\n\nResultsWe edit.',
    );
    expect(out).toBe('Key messages: • At the base. • A*T to G*C. Results: We edit.');
    expect(out).not.toMatch(/^[-+#>]|\n|\*\*|^\d+\. /);
  });
});

describe('escapeMarkdown', () => {
  it.each([
    ['A*T to G*C', 'A\\*T to G\\*C'],
    ['CYP2C19 *2/*35 carriers', 'CYP2C19 \\*2/\\*35 carriers'],
    ['F_{e} and F_{0}', 'F\\_{e} and F\\_{0}'],
    ['O`Toole, P.; O`Riordan, M.', 'O\\`Toole, P.; O\\`Riordan, M.'],
    ['[IQR 3559-8950](P=0.01)', '\\[IQR 3559-8950](P=0.01)'],
    ['dim (~10 lux) and bright (~1500 lux)', 'dim (\\~10 lux) and bright (\\~1500 lux)'],
    ['/api/stereoisomers/<COMP id>', '/api/stereoisomers/\\<COMP id>'],
    ['a \\ backslash', 'a \\\\ backslash'],
  ])('escapes the inline metacharacters in %j', (raw, expected) => {
    expect(escapeMarkdown(raw)).toBe(expected);
  });

  // Each case below is escaped because both markdown-it and marked render it as syntax.
  it.each([
    // A complete tag: both renderers pass it through as raw HTML and the text vanishes.
    ['IL-1<beta> levels rose', 'IL-1\\<beta> levels rose'],
    ['see <https://example.org>', 'see \\<https://example.org>'],
    ['a </b> tag', 'a \\</b> tag'],
    ['_word_ here', '\\_word\\_ here'],
    ['x_ y _z', 'x\\_ y \\_z'],
    ['a~b~c', 'a\\~b\\~c'],
    // Alone in its field, but the next field sits in the same paragraph and can close it.
    ['x ~10 y', 'x \\~10 y'],
    ['a [b] c](x)', 'a \\[b] c](x)'],
    ['[1][ref] cited', '\\[1][ref] cited'],
    ['[1]: https://example.org', '\\[1]: https://example.org'],
  ])('escapes a metacharacter that can open syntax in %j', (raw, expected) => {
    expect(escapeMarkdown(raw)).toBe(expected);
  });

  it.each([
    'p<0.05 and P<.001',
    'x<y and z',
    'IL-1β<5 pg/mL',
    'cc_by_nc_nd',
    'snake_case, Mu_ller, β_1, rs6733839_A',
    'a ~ b and c ~ d',
    'see [IQR 1-2] (P=0.01) and [95% CI 1.2-3.4]',
    'a [1] and [2] cited',
  ])('leaves a metacharacter that cannot open syntax raw: %j', (raw) => {
    expect(escapeMarkdown(raw)).toBe(raw);
  });

  it.each([
    ['1. We first map sites.', '1\\. We first map sites.'],
    ['12) Twelve items.', '12\\) Twelve items.'],
    ['# of patients rose', '\\# of patients rose'],
    ['## Results', '\\## Results'],
    ['first line\n#', 'first line\n\\#'],
    ['> 50% responded', '\\> 50% responded'],
    ['- one item', '\\- one item'],
    ['+ one item', '\\+ one item'],
    ['first line\n2. second line', 'first line\n2\\. second line'],
  ])('escapes the line-initial block marker in %j', (raw, expected) => {
    expect(escapeMarkdown(raw)).toBe(expected);
  });

  it.each([
    "NIH Director's Transformative Research Award",
    'p = 0.01. Results: 12.5% (n = 3) - see #4 > baseline; 1.5-fold',
    // A `#` run is a heading only when a space, tab, or line end follows it.
    '#441914366; IOS #2426305',
    '####### seven hashes',
    '-0.42 and +3 are signed values',
    '1.5 mg/kg',
    'β = ―0.42, ≥98%, ∼10 µm, • item',
  ])('leaves text that renders literally unchanged: %j', (raw) => {
    expect(escapeMarkdown(raw)).toBe(raw);
  });
});

describe('normalizeRorId', () => {
  // Every ROR ID probed against the bioRxiv funder filter: NSF, NIH, NIGMS,
  // Wellcome, HHMI, ERC, DFG, NSFC, EC, MRC, NCI, and two hospital IDs that
  // appear on records.
  it.each([
    '021nxhr62',
    '01cwqze88',
    '04q48ey07',
    '029chgv08',
    '006w34k90',
    '0472cxd90',
    '018mejw64',
    '01h0zpd94',
    '00k4n6c32',
    '03x94j517',
    '040gcmg81',
    '016jc2h42',
    '053658081',
  ])('accepts the real ROR ID %s unchanged', (id) => {
    expect(normalizeRorId(id)).toBe(id);
  });

  it.each([
    ['https://ror.org/021nxhr62', '021nxhr62'],
    ['http://ror.org/021nxhr62/', '021nxhr62'],
    ['ror.org/021nxhr62', '021nxhr62'],
    ['https://www.ror.org/021nxhr62', '021nxhr62'],
    ['HTTPS://ROR.ORG/021NXHR62', '021nxhr62'],
    ['  021nxhr62  ', '021nxhr62'],
  ])('reduces %j to the bare lowercase ID', (input, expected) => {
    expect(normalizeRorId(input)).toBe(expected);
  });

  it.each([
    ['021nxhr6', 'eight characters'],
    ['021nxhr622', 'ten characters'],
    ['021nxhr63', 'checksum off by one'],
    ['0zzzzzz99', 'checksum (the valid one is 02)'],
    ['121nxhr62', 'does not start with 0'],
    ['0ilou0000', 'i, l, o, u are not Crockford base32'],
    ['https://ror.org/021nxhr63', 'URL form with a bad checksum'],
    ['https://example.org/021nxhr62', 'a host other than ror.org'],
    ['National Science Foundation', 'a funder name'],
    ['', 'empty'],
  ])('rejects %j (%s)', (input) => {
    expect(normalizeRorId(input)).toBeUndefined();
  });

  it('accepts a checksum-valid ID it cannot know upstream holds', () => {
    expect(normalizeRorId('0zzzzzz02')).toBe('0zzzzzz02');
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

describe('normalizeDoi', () => {
  const BARE = '10.64898/2026.03.11.711201';

  it.each([
    '10.1101/2024.01.15.575123',
    '10.64898/2026.05.07.723463',
    '10.1101/2020.03.26.20044651',
    '10.1101/339853',
  ])('returns an already-bare DOI unchanged with no version: %s', (doi) => {
    expect(normalizeDoi(doi)).toEqual({ doi });
  });

  it.each([
    [`https://doi.org/${BARE}`],
    [`http://doi.org/${BARE}`],
    [`http://dx.doi.org/${BARE}`],
    [`https://dx.doi.org/${BARE}`],
    [`doi:${BARE}`],
    [`DOI: ${BARE}`],
    [`https://www.biorxiv.org/content/${BARE}`],
    [`https://www.medrxiv.org/content/${BARE}`],
    [`http://biorxiv.org/content/${BARE}`],
    [`medrxiv.org/content/${BARE}`],
    [`${BARE}.full`],
    [`${BARE}.full.pdf`],
    [`${BARE}/`],
    [`\t${BARE}\n`],
  ])('strips the prefix or suffix from %s', (input) => {
    expect(normalizeDoi(input)).toEqual({ doi: BARE });
  });

  it.each([
    [`${BARE}v2`, '2'],
    [`${BARE}v12.full`, '12'],
    [`https://www.biorxiv.org/content/${BARE}v3.full.pdf`, '3'],
    [`https://www.medrxiv.org/content/${BARE}v1.full?versioned=true#sec-2`, '1'],
    [`https://www.biorxiv.org/content/${BARE}v02`, '2'],
    [`${BARE}V2`, '2'],
    [`${BARE}V3.FULL`, '3'],
    [`https://www.biorxiv.org/content/${BARE}v1.article-metrics`, '1'],
    [`https://www.biorxiv.org/content/${BARE}v2.supplementary-material`, '2'],
    [`https://www.biorxiv.org/content/${BARE}v2.article-info`, '2'],
    [`https://www.biorxiv.org/content/${BARE}v1.full-text`, '1'],
    [`https://www.biorxiv.org/content/${BARE}v4.full.pdf+html`, '4'],
  ])('reads the version suffix off %s', (input, version) => {
    expect(normalizeDoi(input)).toEqual({ doi: BARE, version });
  });

  it.each([
    `${BARE}.abstract`,
    `${BARE}.Full.PDF`,
    `https://www.medrxiv.org/content/${BARE}.article-metrics/`,
  ])('strips an article-tab suffix with no version from %s', (input) => {
    expect(normalizeDoi(input)).toEqual({ doi: BARE });
  });

  it('never strips a digit group of the identifier itself', () => {
    expect(normalizeDoi('10.1101/2020.03.26.20044651.full')).toEqual({
      doi: '10.1101/2020.03.26.20044651',
    });
    expect(normalizeDoi('10.1101/339853v1.full')).toEqual({
      doi: '10.1101/339853',
      version: '1',
    });
  });

  it('leaves a v that does not follow a digit, or has no digits after it, in place', () => {
    expect(normalizeDoi('10.1234/abcv2')).toEqual({ doi: '10.1234/abcv2' });
    expect(normalizeDoi(`${BARE}v`)).toEqual({ doi: `${BARE}v` });
  });

  it.each([
    'bad-doi',
    '10notadoi',
    '10.1101/',
    '10.12/short-registrant',
    'https://doi.org/',
    'doi:',
    '',
    '   ',
    '10.1101/2024.01.15 575123',
    'not-a-doi; DROP TABLE preprints;--',
  ])('returns undefined for %j', (input) => {
    expect(normalizeDoi(input)).toBeUndefined();
  });
});
