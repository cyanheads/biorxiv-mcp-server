/**
 * @fileoverview Tests for shared service utilities — detectHtmlError,
 * SERVER_VERSION, normalizeUpstreamText, normalizeDoi, normalizeRorId,
 * escapeMarkdown, parseRetryAfterSeconds, findRateLimit, describeWait, the
 * per-tool-call deadline, and the retry ladder that runs inside it.
 * @module tests/services/shared.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_BUDGET_MS,
  type CallDeadline,
  describeWait,
  detectHtmlError,
  escapeMarkdown,
  findRateLimit,
  ladderBudgetMs,
  normalizeDoi,
  normalizeRorId,
  normalizeUpstreamText,
  parseRetryAfterSeconds,
  remainingBudgetMs,
  retryWithinBudget,
  SERVER_VERSION,
  startCallDeadline,
} from '@/services/shared.js';
import packageJson from '../../package.json' with { type: 'json' };
import { settle } from '../helpers/call-budget.js';
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
    expect(normalizeUpstreamText('significant at p<0.05 in <i>E. coli</i> only')).toBe(
      'significant at p<0.05 in E. coli only',
    );
  });

  it('never splices a tag together from the text around a stripped one', () => {
    // Removing <i> here would join the open `<` to what follows it.
    expect(normalizeUpstreamText('a <scr<i>ipt>alert(1)</script> b')).toBe(
      'a <scr<i>ipt>alert(1)</script> b',
    );
    expect(normalizeUpstreamText('a <<i>iframe onload=x> b')).toBe('a <<i>iframe onload=x> b');
    expect(normalizeUpstreamText('a <iframe src <b>x> b')).toBe('a <iframe src <b>x> b');
    // A stripped tag never re-forms an allowlisted one either.
    expect(normalizeUpstreamText('a <<b>i>x</i> b')).toBe('a <<b>i>x b');
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

  it('reads [xHHHH] as a code point only for a non-ASCII symbol', () => {
    expect(normalizeUpstreamText('[x00B5]M and [x1D7C3]')).toBe('µM and 𝟃');
    // ASCII, control, surrogate, and private-use code points are never Highwire
    // symbols; decoding them would let upstream text spell out markup.
    expect(normalizeUpstreamText('a [x003C]iframe[x003E] b')).toBe('a [x003C]iframe[x003E] b');
    expect(normalizeUpstreamText('a [x003C]<i>iframe[x003E] b')).toBe('a [x003C]iframe[x003E] b');
    expect(normalizeUpstreamText('[x0041] [x0009] [x0085] [xD800] [xE000] [x202E]')).toBe(
      '[x0041] [x0009] [x0085] [xD800] [xE000] [x202E]',
    );
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

  // ── Literal backslash-n line breaks ─────────────────────────────────────────
  // Older bioRxiv abstracts (numeric DOIs, posted before December 2019) mark
  // their line breaks with the two characters `\` `n` and carry no real newline.

  it('reads paired literal \\n\\n paragraph breaks as line breaks, splitting fused headings', () => {
    // Live shape: 10.1101/049882 (all five revisions).
    const raw = String.raw`BackgroundDilp8-mediated inhibition of ecdysone synthesis. We examined early pupal death in certain cases.\n\nResultsOver-expression of activated Ras caused organismal death.\n\nConclusionsOur results reveal a novel checkpoint.`;
    expect(normalizeUpstreamText(raw)).toBe(
      'Background: Dilp8-mediated inhibition of ecdysone synthesis. We examined early pupal death in certain cases. Results: Over-expression of activated Ras caused organismal death. Conclusions: Our results reveal a novel checkpoint.',
    );
  });

  it('reads single literal \\n breaks inside list markup and longer runs as line breaks', () => {
    // Live shapes: 10.1101/248419 (single breaks between list items, a run of four
    // before a figure block) and 10.1101/113506 (a lowercase heading after a break).
    const list = String.raw`We discuss a new approach.\n\nHighlightsO_LISimple models allow deduction of principles\nC_LIO_LIDetailed models can be accurate\nC_LI\n\n\n\nO_FIG O_LINKSMALLFIG SRC=\"FIGDIR/small/248419_ufig1.gif\">\nView larger version (28K):\norg.highwire.dtl.DTLVardef@1cc6c8b M_FIG Graphical abstract\n\nC_FIG`;
    expect(normalizeUpstreamText(list)).toBe(
      'We discuss a new approach. Highlights: • Simple models allow deduction of principles • Detailed models can be accurate',
    );
    const lowercase = String.raw`at low vaccine coverage.\n\nsummaryTargeting health care workers decreases outbreak size.`;
    expect(normalizeUpstreamText(lowercase)).toBe(
      'at low vaccine coverage. summaryTargeting health care workers decreases outbreak size.',
    );
  });

  it('keeps a TeX control word that opens with \\n, and an escaped \\\\, as written', () => {
    const tex = String.raw`the gradient $\nabla f$, where $a \neq b$ and $\ne c$, with frequency $\nu_0$, $x \notin S$, $\neg p$, row\\next, and \newline here`;
    expect(normalizeUpstreamText(tex)).toBe(tex);
    // A TeX word only when its letters end there: `\nuse` and `\nequal` are breaks.
    expect(
      normalizeUpstreamText(String.raw`Intro.\n\nNuclear import.\nuse of it.\nequal parts.`),
    ).toBe('Intro. Nuclear import. use of it. equal parts.');
  });

  it('leaves text with real line breaks byte-identical, a literal \\n in it included', () => {
    // Characterization: upstream uses one form or the other, never both in one
    // field, so text that already carries real line breaks is read as before.
    const raw = 'Intro.\n\nResultsWe used \\n as a separator.';
    expect(normalizeUpstreamText(raw)).toBe(String.raw`Intro. Results: We used \n as a separator.`);
  });

  it('reads a literal \\" as a double quote in the same text', () => {
    // Live shape: 10.1101/113506 (all three revisions) — quotes escaped beside literal breaks.
    const raw = String.raw`a transmission model.\n\nResultsWe found that for some outbreaks (we call \"type 1\") HCW amplified transmission. However, in outbreaks with longer time courses (\"type 2 outbreaks\"), reactive community vaccination decreased the number of cases.`;
    const out = normalizeUpstreamText(raw);
    expect(out).toBe(
      'a transmission model. Results: We found that for some outbreaks (we call "type 1") HCW amplified transmission. However, in outbreaks with longer time courses ("type 2 outbreaks"), reactive community vaccination decreased the number of cases.',
    );
    expect(out).not.toContain('\\');
    // A quote escaped in a field with no literal break is the same form.
    expect(normalizeUpstreamText(String.raw`the \"type 1\" outbreaks`)).toBe(
      'the "type 1" outbreaks',
    );
  });

  it('keeps a \\" after an escaped backslash, and in text with real line breaks, as written', () => {
    const escaped = String.raw`row\\"quoted`;
    expect(normalizeUpstreamText(escaped)).toBe(escaped);
    const raw = 'Intro.\n\nResultsWe call it \\"type 1\\".';
    expect(normalizeUpstreamText(raw)).toBe(String.raw`Intro. Results: We call it \"type 1\".`);
  });

  it('leaves text without a backslash byte-identical', () => {
    // Characterization: titles and recent abstracts carry no backslash at all.
    const raw = 'Ras signaling in eye discs: a novel post-pupariation checkpoint';
    expect(normalizeUpstreamText(raw)).toBe(raw);
  });

  describe('literal \\n conversion runs in linear time', () => {
    /** Thread CPU microseconds one call takes, the least of three runs. */
    function cpuMicros(text: string): number {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        normalizeUpstreamText(text);
        const spent = process.threadCpuUsage(start);
        best = Math.min(best, spent.user + spent.system);
      }
      return best;
    }

    /** The unit repeated to `chars` characters, then the tail. */
    const build = (unit: string, chars: number, tail = '') =>
      unit.repeat(Math.ceil(chars / unit.length)) + tail;

    it.each([
      ['a long line ending in a real break', '§1 x', '\ny'],
      ['real breaks throughout', '  \r\n', ''],
      ['a long line ending in a literal break', '§1 x', String.raw`\ny`],
      ['literal breaks throughout', String.raw`\n`, ''],
      ['a repeated TeX prefix with no ending', String.raw`\nabl`, ''],
      ['a repeated TeX word', String.raw`\ne`, ''],
      ['escaped backslashes before n', String.raw`\\n`, ''],
      ['a long line ending in a literal quote', '§1 x', String.raw`\"y`],
      ['literal quotes throughout', String.raw`\"`, ''],
      ['escaped backslashes before a quote', String.raw`\\"`, ''],
    ])('%s: 5k → 320k characters', (_shape, unit, tail) => {
      const timings: number[] = [];
      for (let chars = 5_000; chars <= 320_000; chars *= 2) {
        const micros = cpuMicros(build(unit, chars, tail));
        expect(micros).toBeLessThan(250_000);
        timings.push(micros);
      }
      const first = Math.max(timings[0] ?? 1, 1);
      const last = timings.at(-1) ?? 0;
      // The conversion scales linearly with input size.
      expect(last / first).toBeLessThan(256);
    });
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

  // An ATX heading drops a `#` run that ends its line after a space or tab as
  // its closing sequence, and every title sits in a heading in some tool.
  it.each([
    ['abc #', 'abc \\#'],
    ['abc ##', 'abc #\\#'],
    ['abc\t#', 'abc\t\\#'],
    ['abc #  ', 'abc \\#  '],
    ['abc #\t', 'abc \\#\t'],
    ['Cohort study of patient #', 'Cohort study of patient \\#'],
    ['ends with ### and more ###', 'ends with ### and more ##\\#'],
    ['abc # x #', 'abc # x \\#'],
    ['# #', '\\# \\#'],
    ['first #\nsecond #', 'first \\#\nsecond \\#'],
    ['first #\r\nsecond', 'first \\#\r\nsecond'],
    ['first #\rsecond', 'first \\#\rsecond'],
    ['A*T to G*C ##', 'A\\*T to G\\*C #\\#'],
    ['#######', '######\\#'],
    ['####### ', '######\\# '],
  ])('escapes the last # of a closing run in %j', (raw, expected) => {
    expect(escapeMarkdown(raw)).toBe(expected);
  });

  it.each([
    ['#', '\\#'],
    ['##', '\\##'],
    ['#  ', '\\#  '],
    ['  #', '  \\#'],
    ['first line\n##', 'first line\n\\##'],
    ['a \\#', 'a \\\\#'],
  ])(
    'keeps the line-initial or backslash escape of %j without a second backslash',
    (raw, expected) => {
      expect(escapeMarkdown(raw)).toBe(expected);
    },
  );

  it.each(['abc#', 'C# and F# interop', 'a # b', 'Issue #4', 'abc #x', 'abc # \u00a0'])(
    'leaves a # run that cannot close a heading raw: %j',
    (raw) => {
      expect(escapeMarkdown(raw)).toBe(raw);
    },
  );

  describe('runs in linear time', () => {
    /** Thread CPU microseconds one call takes, the least of three runs. */
    function cpuMicros(text: string): number {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        escapeMarkdown(text);
        const spent = process.threadCpuUsage(start);
        best = Math.min(best, spent.user + spent.system);
      }
      return best;
    }

    /** `head`, then the unit repeated to `chars` characters, then the tail. */
    const build = (unit: string, chars: number, tail = '', head = '') =>
      head + unit.repeat(Math.ceil(chars / unit.length)) + tail;

    // Each size's bound is checked before the next runs, so a quadratic scan
    // fails at its first oversized step rather than at 320k.
    it.each([
      ['a long digit run', '1', ''],
      ['a long # run no space precedes', '#', '', 'x'],
      ['a long # run a space precedes, then text', '#', 'x', ' '],
      ['space-preceded # runs throughout', ' #', ''],
      ['space-preceded # runs, no line end', ' # ', 'x'],
      ['a long space and tab run before a #', ' \t', '#x'],
      ['a long line ending in a real break', '§1 #', '\ny'],
      ['real breaks throughout', '  \r\n', ''],
      ['closing runs before breaks throughout', ' # \r\n', ''],
      ['[ with no link closer after it', '[', ''],
      ['[ with one link closer at the very end', '[', '](x)'],
      ['a line-initial [ on every line', '[\n', ''],
      ['[ with breaks throughout', '[  \r\n', ''],
      ['< before a letter with no > after it', '<a', ''],
      ['< before a letter with breaks throughout', '<a  \r\n', ''],
    ])('%s: 5k → 320k characters', (_shape, unit, tail, head = '') => {
      const timings: number[] = [];
      for (let chars = 5_000; chars <= 320_000; chars *= 2) {
        const micros = cpuMicros(build(unit, chars, tail, head));
        expect(micros).toBeLessThan(250_000);
        timings.push(micros);
      }
      const first = Math.max(timings[0] ?? 1, 1);
      const last = timings.at(-1) ?? 0;
      // Escaping scales linearly with input size.
      expect(last / first).toBeLessThan(256);
    });
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
  });

  it('reads a zero delta as no usable wait, so callers word it like a missing header', () => {
    expect(parseRetryAfterSeconds('0')).toBeUndefined();
    expect(parseRetryAfterSeconds(' 0 ')).toBeUndefined();
    expect(parseRetryAfterSeconds('000')).toBeUndefined();
  });

  it('converts the RFC 9110 HTTP-date form to a wait from now', () => {
    const twoMinutesOut = new Date(Date.now() + 120_000).toUTCString();
    const seconds = parseRetryAfterSeconds(twoMinutesOut);
    expect(seconds).toBeGreaterThan(110);
    expect(seconds).toBeLessThanOrEqual(120);
  });

  it('reads an HTTP-date already in the past as no usable wait rather than a zero or negative one', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(past)).toBeUndefined();
  });

  it('returns undefined for an unparseable or absent value so callers word it generically', () => {
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    expect(parseRetryAfterSeconds(94)).toBeUndefined();
  });
});

describe('describeWait', () => {
  it('names a wait in seconds, singular for one', () => {
    expect(describeWait(1)).toBe('1 second');
    expect(describeWait(2)).toBe('2 seconds');
    expect(describeWait(94)).toBe('94 seconds');
  });

  it('falls back to a generic phrase when no usable wait was named', () => {
    expect(describeWait(undefined)).toBe('a minute or two');
  });
});

describe('call deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('budgets 50 s per tool call, under the 60 s MCP client request timeout', () => {
    expect(CALL_BUDGET_MS).toBe(50_000);
    expect(startCallDeadline()).toBe(Date.now() + 50_000);
  });

  it('counts down from the instant the call started, not from each request', () => {
    const deadline = startCallDeadline();
    expect(remainingBudgetMs(deadline)).toBe(50_000);
    vi.advanceTimersByTime(30_000);
    expect(remainingBudgetMs(deadline)).toBe(20_000);
    vi.advanceTimersByTime(19_999);
    expect(remainingBudgetMs(deadline)).toBe(1);
  });

  it('reads 0 at the deadline and past it, never a negative budget', () => {
    const deadline = startCallDeadline();
    vi.advanceTimersByTime(50_000);
    expect(remainingBudgetMs(deadline)).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(remainingBudgetMs(deadline)).toBe(0);
  });

  it('hands a ladder what is left of the budget, down to its last millisecond', () => {
    const deadline = startCallDeadline();
    expect(ladderBudgetMs(deadline, 'Service.op')).toBe(50_000);
    vi.advanceTimersByTime(49_999);
    expect(ladderBudgetMs(deadline, 'Service.op')).toBe(1);
  });

  it('fails a ladder the spent budget leaves nothing for as the call running out of time', () => {
    const deadline = startCallDeadline();
    vi.advanceTimersByTime(50_000);
    let err: unknown;
    try {
      ladderBudgetMs(deadline, 'Service.op');
    } catch (thrown) {
      err = thrown;
    }
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: "Service.op was not attempted — the call's 50 s time budget had run out.",
      data: { reason: 'retry_deadline_exceeded', retryAttempts: 0 },
    });
  });
});

describe('retryWithinBudget', () => {
  const http429 = (retryAfter?: string) =>
    new McpError(JsonRpcErrorCode.RateLimited, 'Status: 429', {
      status: 429,
      ...(retryAfter !== undefined && { retryAfter }),
    });
  /** An attempt still waiting on its origin until the ladder's signal aborts. */
  const hangs = ({ signal }: { signal: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  /** Runs `attempts` in turn, the last one for every attempt after it. */
  const ladder = (
    deadline: CallDeadline,
    attempts: ((a: { signal: AbortSignal }) => Promise<unknown>)[],
    signal?: AbortSignal,
  ) => {
    let n = 0;
    const attempt = vi.fn((a: { signal: AbortSignal }) => {
      const run = attempts[Math.min(n, attempts.length - 1)] as (typeof attempts)[number];
      n += 1;
      return run(a);
    });
    const call = retryWithinBudget(attempt, {
      operation: 'Service.op',
      baseDelayMs: 1_000,
      jitter: 0,
      deadline,
      ...(signal && { signal }),
    });
    return { attempt, call };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('fails before any attempt once the budget is spent, as the call running out of time', async () => {
    const deadline = startCallDeadline();
    vi.advanceTimersByTime(CALL_BUDGET_MS);
    const { attempt, call } = ladder(deadline, [() => Promise.resolve('ok')]);
    const { err } = await settle(call);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: "Service.op was not attempted — the call's 50 s time budget had run out.",
      data: { reason: 'retry_deadline_exceeded', retryAttempts: 0 },
    });
    expect(attempt).not.toHaveBeenCalled();
  });

  it('bounds the ladder by what is left of the budget', async () => {
    const deadline = (Date.now() + 3_000) as CallDeadline;
    const { attempt, call } = ladder(deadline, [hangs]);
    const { err, elapsedMs } = await settle(call);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'Service.op exceeded its 3000ms retry deadline after 1 attempt.',
      data: { reason: 'retry_deadline_exceeded', retryAttempts: 1 },
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBe(3_000);
  });

  it('rejects with the 429 an attempt received when the budget ran out in the backoff after it', async () => {
    const limited = http429();
    // 500 ms left, less than the 1 s backoff before a second attempt.
    const { attempt, call } = ladder((Date.now() + 500) as CallDeadline, [
      () => Promise.reject(limited),
    ]);
    const { err } = await settle(call);

    expect(err).toBe(limited);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rejects with the last 429 an attempt received when the budget cut a later attempt short', async () => {
    const first = http429('1');
    const second = http429('2');
    const { attempt, call } = ladder((Date.now() + 10_000) as CallDeadline, [
      () => Promise.reject(first),
      () => Promise.reject(second),
      hangs,
    ]);
    const { err, elapsedMs } = await settle(call);

    expect(err).toBe(second);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(elapsedMs).toBe(10_000);
  });

  it('keeps an expiry with no 429 behind it an expiry, whatever the attempts threw', async () => {
    const outage = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Status: 503', {
      status: 503,
    });
    const { call } = ladder((Date.now() + 10_000) as CallDeadline, [
      () => Promise.reject(outage),
      hangs,
    ]);
    const { err } = await settle(call);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', retryAttempts: 2 },
    });
  });

  it('rejects with every other failure as withRetry threw it', async () => {
    const plain = new McpError(JsonRpcErrorCode.InvalidParams, 'Status: 400', {
      status: 400,
      retryable: false,
    });
    expect(
      (await settle(ladder(startCallDeadline(), [() => Promise.reject(plain)]).call)).err,
    ).toBe(plain);

    // 429s until the attempts run out inside the budget: the exhausted error,
    // whose data keeps the 429's status.
    const { err: exhausted } = await settle(
      ladder(startCallDeadline(), [() => Promise.reject(http429())]).call,
    );
    expect(exhausted).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      message: 'Status: 429 (failed after 4 attempts)',
      data: { status: 429, retryAttempts: 4 },
    });
  });

  it('keeps a caller cancellation after a 429 a cancellation, never the 429', async () => {
    const caller = new AbortController();
    const cancelled = new Error('cancelled by caller');
    setTimeout(() => caller.abort(cancelled), 5_000);
    const { call } = ladder(
      startCallDeadline(),
      [() => Promise.reject(http429()), hangs],
      caller.signal,
    );
    const { err, elapsedMs } = await settle(call);

    expect(err).toBe(cancelled);
    expect(elapsedMs).toBe(5_000);
  });

  describe('pacing against an origin that answers every attempt with a 429 at once', () => {
    /**
     * Runs a ladder whose every attempt rejects with a 429 carrying `retryAfter`
     * (`'past'` stands for an HTTP-date a minute ago), with `budgetMs` of the
     * call left. Reports when each attempt started, in ms after the first, and
     * what the ladder rejected with.
     */
    const pace = async (retryAfter: string | undefined, budgetMs: number = CALL_BUDGET_MS) => {
      const started = Date.now();
      const header = retryAfter === 'past' ? new Date(started - 60_000).toUTCString() : retryAfter;
      const limited = http429(header);
      const startedAt: number[] = [];
      const { call } = ladder((started + budgetMs) as CallDeadline, [
        () => {
          startedAt.push(Date.now() - started);
          return Promise.reject(limited);
        },
      ]);
      const { err } = await settle(call);
      return { startedAt, err, limited };
    };
    /** The exhausted error four header-less 429s end in. */
    const exhausted = {
      code: JsonRpcErrorCode.RateLimited,
      message: 'Status: 429 (failed after 4 attempts)',
      data: { status: 429, retryAttempts: 4, operation: 'Service.op' },
    };

    it.each([
      ['no Retry-After', undefined],
      ['Retry-After: 0', '0'],
      ['an HTTP-date already past', 'past'],
    ])(
      'backs off exponentially on a 429 with %s, then exhausts the ladder',
      async (_label, retryAfter) => {
        const { startedAt, err } = await pace(retryAfter);

        // baseDelayMs 1 s, no jitter: waits of 1, 2, and 4 s.
        expect(startedAt).toEqual([0, 1_000, 3_000, 7_000]);
        expect(err).toBeInstanceOf(McpError);
        expect(err).toMatchObject({ code: exhausted.code, message: exhausted.message });
        expect(err.data).toEqual(exhausted.data);
      },
    );

    it('waits a positive Retry-After within the cap and the budget, in place of the backoff', async () => {
      const { startedAt, err } = await pace('2');

      expect(startedAt).toEqual([0, 2_000, 4_000, 6_000]);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        message: 'Status: 429 (failed after 4 attempts)',
        data: { status: 429, retryAfter: '2', retryAttempts: 4 },
      });
    });

    it.each([
      ['longer than the budget leaves', '5', 3_000],
      ['longer than the 30 s cap', '66', CALL_BUDGET_MS],
    ])(
      'rejects after one request with a Retry-After %s, the 429 untouched',
      async (_label, retryAfter, budgetMs) => {
        const { startedAt, err, limited } = await pace(retryAfter, budgetMs);

        expect(startedAt).toEqual([0]);
        expect(err).toBe(limited);
        expect(err.data).toMatchObject({ retryAfter });
      },
    );

    it.each([
      ['no Retry-After', undefined],
      ['Retry-After: 0', '0'],
      ['an HTTP-date already past', 'past'],
    ])(
      'rejects with the 429 itself, never an expiry, when the backoff after a 429 with %s outlasts the budget',
      async (_label, retryAfter) => {
        // 1.2 s left: the 1 s backoff fits, the 2 s one after the second attempt does not.
        const { startedAt, err, limited } = await pace(retryAfter, 1_200);

        expect(startedAt).toEqual([0, 1_000]);
        expect(err).toBe(limited);
        expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      },
    );
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

  // A journal's component DOIs (peer-review reports, figures, tables, Wiley's
  // `.x`) end in a `.`-component of the DOI itself; stripping it names the
  // parent record.
  it.each([
    '10.7554/eLife.55185.sa1',
    '10.7554/eLife.55185.sa2',
    '10.1371/journal.pone.0123456.g001',
    '10.1371/journal.pone.0123456.t001',
    '10.1111/j.1365-2958.2006.05172.x',
    '10.21203/rs.3.rs-123456/v1',
  ])('keeps the suffix of a journal DOI: %s', (doi) => {
    expect(normalizeDoi(doi)).toEqual({ doi });
    expect(normalizeDoi(`https://doi.org/${doi}`)).toEqual({ doi });
  });

  // A journal DOI pasted with a page-format or revision suffix still names the
  // article: those suffixes are never part of a registered DOI.
  it.each([
    ['10.1016/j.cell.2020.01.001.pdf', { doi: '10.1016/j.cell.2020.01.001' }],
    ['10.1016/j.cell.2020.01.001.full', { doi: '10.1016/j.cell.2020.01.001' }],
    ['10.1016/j.cell.2020.01.001.full.pdf', { doi: '10.1016/j.cell.2020.01.001' }],
    ['10.1016/j.cell.2020.01.001.full-text', { doi: '10.1016/j.cell.2020.01.001' }],
    ['10.1016/j.cell.2020.01.001.Full.PDF/', { doi: '10.1016/j.cell.2020.01.001' }],
    ['10.3389/fimmu.2020.01234.full', { doi: '10.3389/fimmu.2020.01234' }],
    ['10.1186/s13059-020-02154-5.pdf', { doi: '10.1186/s13059-020-02154-5' }],
    ['10.1038/s41586-020-2012-7v2', { doi: '10.1038/s41586-020-2012-7', version: '2' }],
    ['10.1038/s41586-020-2012-7v2.full', { doi: '10.1038/s41586-020-2012-7', version: '2' }],
    ['10.5281/zenodo.1234567V3.pdf', { doi: '10.5281/zenodo.1234567', version: '3' }],
    ['10.7554/eLife.55185.sa1.pdf', { doi: '10.7554/eLife.55185.sa1' }],
    ['10.1111/j.1365-2958.2006.05172.x.pdf', { doi: '10.1111/j.1365-2958.2006.05172.x' }],
  ])('strips the page-format or revision suffix from journal DOI %s', (input, expected) => {
    expect(normalizeDoi(input)).toEqual(expected);
    expect(normalizeDoi(`https://doi.org/${input}`)).toEqual(expected);
  });

  describe('reads a journal DOI suffix in linear time', () => {
    /** Thread CPU microseconds one call takes, the least of three runs. */
    function cpuMicros(text: string): number {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        normalizeDoi(text);
        const spent = process.threadCpuUsage(start);
        best = Math.min(best, spent.user + spent.system);
      }
      return best;
    }

    /** A journal DOI whose suffix is the unit repeated to `chars` characters, then the tail. */
    const build = (unit: string, chars: number, tail = '') =>
      `10.1016/j${unit.repeat(Math.ceil(chars / unit.length))}${tail}`;

    it.each([
      ['a long line ending in a real break', '§1 x', '\ny'],
      ['real breaks throughout', '  \r\n', ''],
      ['page-format suffixes throughout', '.pdf', ''],
      ['page-format suffixes ending in another component', '.pdf', '.x'],
      ['revision-like runs ending in a letter', '1v1', 'x'],
    ])('%s: 5k → 320k characters', (_shape, unit, tail) => {
      const timings: number[] = [];
      for (let chars = 5_000; chars <= 320_000; chars *= 2) {
        const micros = cpuMicros(build(unit, chars, tail));
        expect(micros).toBeLessThan(250_000);
        timings.push(micros);
      }
      const first = Math.max(timings[0] ?? 1, 1);
      const last = timings.at(-1) ?? 0;
      // Reading the suffix scales linearly with input size.
      expect(last / first).toBeLessThan(256);
    });
  });

  it.each([
    ['10.1038/nature12373/', '10.1038/nature12373'],
    ['https://doi.org/10.1038/S41586-020-2380-Z/', '10.1038/S41586-020-2380-Z'],
    ['doi: 10.7554/eLife.55185.sa1/', '10.7554/eLife.55185.sa1'],
  ])('drops only the trailing slash from a journal DOI: %s', (input, doi) => {
    expect(normalizeDoi(input)).toEqual({ doi });
  });

  it.each([
    ['10.1101/2020.03.21.990770v2', { doi: '10.1101/2020.03.21.990770', version: '2' }],
    ['10.1101/2020.03.21.990770v1.full', { doi: '10.1101/2020.03.21.990770', version: '1' }],
    ['https://doi.org/10.1101/2020.03.21.990770', { doi: '10.1101/2020.03.21.990770' }],
  ])('still strips the article-page suffix from a preprint DOI: %s', (input, expected) => {
    expect(normalizeDoi(input)).toEqual(expected);
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
