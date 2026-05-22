# biorxiv-mcp-server — Idea

Pre-design seed. Feeds into `design-mcp-server` to produce `docs/design.md`.

## Domain

bioRxiv and medRxiv — the dominant biomedical preprint servers (Cold Spring Harbor Lab). ~400K bioRxiv + ~70K medRxiv preprints. Pre-publication research in life sciences and clinical/health, often months ahead of journal publication. Tracks the relationship between a preprint and its eventually-published journal version.

## Data source

- **API:** https://api.biorxiv.org/
- **Auth:** none required
- **Rate limit:** undocumented; gentle, but be polite (mailto user-agent)
- **Format:** JSON; DOI is primary key; servers: `biorxiv`, `medrxiv` (same API)
- **Note:** native search is weak — keyword search likely needs EuropePMC fallback (already wrapped by `pubmed-mcp-server`)

## User goals

- Recent preprints in a date interval — common ask for "what's new in X field"
- Resolve a DOI to preprint metadata + abstract + revision history
- Find the published-journal-version DOI for a preprint (or vice versa)
- Pull author publications across both servers
- Filter by category (Neuroscience, Genomics, Epidemiology, …)

## Tool sketch

| Tool | Purpose |
|:-----|:--------|
| `biorxiv_get_preprint` | DOI → preprint metadata, abstract, all revisions, full-text/PDF links, published-version DOI if any |
| `biorxiv_list_recent` | Recent preprints in a date interval, optionally filtered by server and category |
| `biorxiv_get_published_version` | Crosswalk between preprint DOI and published-journal DOI |
| `biorxiv_search_preprints` | Keyword search — EuropePMC fallback for relevance, biorxiv API for canonical metadata |

## Pairs with

- **pubmed-mcp-server** — post-publication side; biorxiv is the pre-publication pipeline. Many medical works appear here first.
- **arxiv-mcp-server** — non-overlapping disciplines (physics/math/CS vs bio/medicine), same agent ergonomics
- **crossref-mcp-server** — Crossref carries preprint DOIs; biorxiv API has richer revision/published-version metadata
- **openalex-mcp-server** — preprint analytics + author disambiguation

## Open questions

- Search relevance is the weak point — commit to EuropePMC fallback, or live with date-range browsing for v1?
- Full-text retrieval — bioRxiv exposes PDF links and a TDM API for full text; in scope or defer?
- Category taxonomy — hardcode the known list (~30 bio + ~50 med categories) or fetch dynamically?
- Two-server fan-out: every list/search call probably wants both `biorxiv` + `medrxiv` by default with a flag to scope down
