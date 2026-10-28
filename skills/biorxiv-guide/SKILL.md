---
name: biorxiv-guide
description: Search syntax, identifier origins, and counting gates for the biorxiv_* tools over bioRxiv and medRxiv preprints. Use when finding preprints by topic, author, or date window; counting what a category, funder, or journal took up; tracing a preprint to its journal article or back; or reading a preprint's full text or an earlier revision.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

bioRxiv (biology) and medRxiv (health sciences) preprints: metadata, every revision, the preprint-to-journal crosswalk, and full text. Keyless. Listings and DOI lookups read api.biorxiv.org; keyword search is EuropePMC's ranked index, restricted to the two servers, so arXiv, Research Square, SSRN, and other preprint servers never appear.

No citation counts and no journal-article content beyond the crosswalk record. Pair with a PubMed, Crossref, or OpenAlex server for the journal side, and with an arXiv server for computational biology posted only there.

## Identifiers

- **DOI prefix is an era, not a server.** `10.1101/` is the older prefix and `10.64898/` the newer; bioRxiv and medRxiv both issue both, and a preprint keeps its DOI through every revision (`10.1101/2025.11.24.690249` was revised as v2 under `10.1101/` long after new submissions moved to `10.64898/`). Leave `server` at `"both"` for DOI lookups; the response names the server that holds it.
- **The date inside a DOI is the submission date, not the posting date.** `10.1101/2024.01.03.573434` was posted 2024-01-04; `10.1101/2025.05.22.653117` on 2025-05-27. Read `date` (or `preprintDate` on crosswalk rows) for when a preprint appeared. Older bioRxiv DOIs are plain serials with no date (`10.1101/049882`).
- **Versions.** Each revision has its own title, authors, and date; `biorxiv_get_preprint` lists them. Only the latest revision carries an abstract — the API keeps one per preprint. An earlier revision's own abstract and text come from `biorxiv_get_fulltext` with `version`: `10.1101/049882` v1 opens with a different abstract than the one `biorxiv_get_preprint` returns.
- **Category strings** come from `biorxiv_list_categories`, or from any record's `category` field, which is accepted as input as written.
- **Funder** is a ROR ID (`https://ror.org/<id>`), looked up by name at ror.org. A Crossref Funder Registry ID (`100000002`) is not one and is rejected before any request.
- **Publisher** is the DOI prefix of a journal publisher, the part before the slash, taken from any article DOI of the journal you care about. It names the whole publisher, not one journal: `10.1038` returns rows from many Springer Nature journals at once (`s41467-`, `s41598-`, `s41593-`, and more DOI stems on one two-day page).

## Gates

### Keyword search (`biorxiv_search_preprints`)

`query` is EuropePMC query syntax, passed through and joined to the server's own clauses with `AND`.

- **Wrap every `OR` in parentheses.** The server appends `AND <date and server clauses>`, and in EuropePMC's parser an unparenthesized `OR` before an `AND` stops constraining the match: `transformer OR CRISPR` returns exactly the hits for `CRISPR` alone, while `(transformer OR CRISPR)` returns both sets. The same applies to any `OR` inside a larger query.
- **Spell out synonyms yourself.** Synonym expansion is off, so `"heart attack"` misses the far larger set written `"myocardial infarction"`. Search `("heart attack" OR "myocardial infarction")`.
- **Scope by field when precision matters.** A bare term or phrase matches more than the title and abstract. `TITLE_ABS:"…"`, `TITLE:"…"`, `ABSTRACT:"…"`, `AUTH:"…"`, and `AFF:"…"` all work inside `query`; `TITLE_ABS:"base editing"` and `TITLE:"base editing"` each match fewer records than the bare phrase.
- **Author names.** `author` becomes `AUTH:"…"`. A full name and `Surname Initial` match the same records (`Jennifer Doudna`, `Doudna J`); adding a middle initial (`Doudna JA`) drops records indexed without it. The surname alone is broadest. Confirm identity from co-authors and institution before attributing a list to one person.
- **`server` scopes the search itself**, not only enrichment: `"medrxiv"` returns medRxiv preprints only.
- **The date window is first posting; the record shows the latest revision.** `date_from` / `date_to` filter on when v1 appeared, while each result's `date` and `version` are the latest revision's: a January 2024 window returned `10.1101/2024.01.29.577624` dated 2024-12-15, v2. Never re-filter search results on `date` to enforce the window.

### Posting-date listing (`biorxiv_list_recent`)

- **Rows are revisions, and `total` counts them.** A revised preprint reappears on the day its new version posts, under its old DOI and `version` 2, 3, …. bioRxiv's 2026-10-01..07 listing held 1,460 rows, of which 1,092 were new preprints. To count or list new preprints, keep `version` `"1"` rows.
- **It has no keyword filter.** At 30 rows a page, one bioRxiv week runs to dozens of pages. For a topic within a window, search with `date_from` / `date_to` and filter enriched results on `category` locally; reserve the listing for a complete category census or for the last day or two that EuropePMC has not indexed yet.
- **A funder filter is not a funder's output.** It reaches only records api.biorxiv.org linked to that ROR ID: NIH (`01cwqze88`) returned 9 rows for that same week, all of them revisions. Report what it returns as "preprints bioRxiv links to this funder", never as everything the funder supported.

### Journal crosswalk

- **A missing `publishedJournalDoi` means bioRxiv records no journal version**, which is not proof that none exists. Before reporting a preprint as unpublished, search the journal literature by its authors and key title words on a PubMed or Crossref server; titles drift, as `10.1101/049882`'s did across its five revisions.
- **medRxiv's `type` reads `PUBLISHAHEADOFPRINT` on its preprints**, published or not. It says nothing about journal publication; `publishedJournalDoi` does.
- **Publication listings count rows, not preprints.** medRxiv can list one preprint twice with different `preprintDate` values (one week's first page: 100 rows, 97 distinct preprints). Deduplicate on `preprintDoi` before counting.
- **A past interval's total keeps growing** as bioRxiv records more matches (the medRxiv week 2026-09-01..07 held 103 rows on 2026-10-17 and 107 on 2026-10-28). State counts as of the day you ran them, and finish a walk in one session.

## Workflows

**New preprints on a topic in a period.** `biorxiv_search_preprints` with a parenthesized, field-scoped query and `date_from` / `date_to`, `include_abstract: false` and `limit: 100` for triage, passing each `nextCursorMark` back as `cursor_mark`. Narrow to a field by the `category` on enriched results (EuropePMC-fallback results carry none). Read abstracts for the shortlist with `biorxiv_get_preprint` (10 DOIs a call). For the last day or two, add a `biorxiv_list_recent` pass with `category`.

**Everything a category posted in a window.** `biorxiv_list_recent` with `category`, each server advanced at its own `nextCursor` until none is returned; keep `version` `"1"` rows for new preprints.

**Find a person's preprints.** `author` (surname plus initial, then surname alone if the list looks short) with `server` when the field is clear; add a topic `query` to separate namesakes.

**Has this preprint been published, and where?** `biorxiv_get_preprint` shows `publishedJournalDoi`; `biorxiv_get_published_version` adds the journal name and date. Holding the journal article instead, pass its DOI to `biorxiv_get_published_version` to find the preprint. A not-found answer is bioRxiv's record only, per the crosswalk gate.

**What a journal or publisher took up in a period.** `biorxiv_list_published_versions` filters on the journal's publication date, so the preprints can be years older.

- One bioRxiv publisher: pass `publisher` and walk with `limit: 100`. Rows carry no journal name, so isolate one journal by its DOI stem in `publishedDoi` (`10.1038/s41422-` is Cell Research), then call `biorxiv_get_published_version` for the full record of rows you keep.
- medRxiv, or a journal named in words: list without `publisher` on the one server and match `publishedJournal`, which those rows carry.
- Deduplicate on `preprintDoi` before counting.

**Read a preprint.** `biorxiv_get_fulltext` returns sections as `## ` headings; every chunk reports `totalChars`, and a `limit` at or above it from `offset` 0 returns the whole text in one call. Table cells are never in the text; `omittedTables` gives the page that serves each table's values. To compare what the preprint claimed at first with what it claims now, read `version: 1` beside the latest.
