/**
 * @fileoverview Live `/pubs` records for journal publication dates 2026-09-01
 * to 2026-09-07, captured from api.biorxiv.org on 2026-10-15 and trimmed to one
 * abstract sentence. Every interval row carries all twelve keys; bioRxiv held
 * 449 rows that week and medRxiv 103, so medRxiv's page at cursor 100 holds the
 * three rows below and nothing past them. Also live `/publisher` rows and
 * statuses, whose six-key rows name the preprint as `biorxiv_doi`.
 * @module tests/helpers/pubs-fixtures
 */

import type { PublishedVersion, RawPublishedRecord } from '@/services/biorxiv/types.js';

/** bioRxiv page 0, row 0 — a `10.64898/` preprint posted eight months before publication. */
export const PUBS_ROW_64898: RawPublishedRecord & { preprint_platform: string } = {
  preprint_doi: '10.64898/2026.01.10.693661',
  published_doi: '10.1038/s41467-026-77129-4',
  published_journal: 'Nature Communications',
  preprint_platform: 'bioRxiv',
  preprint_title: 'Regulatory Mechanisms of Maternal Imprinting at the Dlk1-Dio3 Domain',
  preprint_authors:
    'Weinberg-Shukron, A.; Dearden, F. L.; Moreno-Barriga, A.; New, L. T. N.; Müller, M.; Rancourt, R. C.; Edwards, C. A.; Ferguson-Smith, A. C.',
  preprint_category: 'genetics',
  preprint_date: '2026-01-10',
  published_date: '2026-09-02',
  preprint_abstract:
    'Genomic imprinting is an epigenetic process causing parent-of-origin specific gene expression.',
  preprint_author_corresponding: 'Anne C. Ferguson-Smith',
  preprint_author_corresponding_institution: 'Department of Genetics, University of Cambridge',
};

/** `PUBS_ROW_64898` normalized — the crosswalk record every `/pubs` path returns for it. */
export const PUBLISHED_64898: PublishedVersion = {
  preprintDoi: '10.64898/2026.01.10.693661',
  publishedDoi: '10.1038/s41467-026-77129-4',
  publishedJournal: 'Nature Communications',
  publishedDate: '2026-09-02',
  preprintTitle: 'Regulatory Mechanisms of Maternal Imprinting at the Dlk1-Dio3 Domain',
  preprintAuthors:
    'Weinberg-Shukron, A.; Dearden, F. L.; Moreno-Barriga, A.; New, L. T. N.; Müller, M.; Rancourt, R. C.; Edwards, C. A.; Ferguson-Smith, A. C.',
  preprintCategory: 'genetics',
  preprintDate: '2026-01-10',
  preprintAbstract:
    'Genomic imprinting is an epigenetic process causing parent-of-origin specific gene expression.',
  preprintAuthorCorresponding: 'Anne C. Ferguson-Smith',
  preprintAuthorCorrespondingInstitution: 'Department of Genetics, University of Cambridge',
};

/** bioRxiv page 0 — a `10.1101/` preprint whose DOI date (11-21) is not its posting date (11-22). */
export const PUBS_ROW_1101: RawPublishedRecord = {
  preprint_doi: '10.1101/2025.11.21.689628',
  published_doi: '10.1038/s42003-026-10580-7',
  published_journal: 'Communications Biology',
  preprint_title:
    'Observations of anisotropic paramagnetic and diamagnetic susceptibility in the primate brain',
  preprint_authors:
    'Chen, J.; Gkotsoulias, D. G.; Jaffe, J. E.; Grassle, T.; Jaeger, C.; Gone Bi, Z. B.; Crockford, C.; Wittig, R.; Moeller, H. E.; Liu, C.',
  preprint_category: 'neuroscience',
  preprint_date: '2025-11-22',
  published_date: '2026-09-03',
  preprint_abstract:
    'Bulk magnetic susceptibility in the brain white matter is known to be diamagnetic and anisotropic due to the ordered myelin lipids.',
  preprint_author_corresponding: 'Jingjia Chen',
  preprint_author_corresponding_institution: 'New York University',
};

/** medRxiv page at cursor 100 — the last three of its 103 rows that week. */
export const MEDRXIV_C100_ROWS: RawPublishedRecord[] = [
  {
    preprint_doi: '10.1101/2025.08.19.25333983',
    published_doi: '10.3389/fdgth.2026.1823218',
    published_journal: 'Frontiers in Digital Health',
    preprint_title:
      'A pilot comparison of remote versus in-clinic digital cognitive assessments for older adults in primary care settings.',
    preprint_authors: 'Thompson, L.; Eaton, C.; Prieto, S.',
    preprint_category: 'geriatric medicine',
    preprint_date: '2025-08-21',
    published_date: '2026-09-03',
    preprint_abstract:
      'BACKGROUNDImproved methods of cognitive testing are urgently needed for primary care settings.',
    preprint_author_corresponding: 'Louisa Thompson',
    preprint_author_corresponding_institution:
      'Department of Psychiatry & Human Behavior, Alpert Medical School of Brown University',
  },
  {
    preprint_doi: '10.1101/2025.09.03.25334908',
    published_doi: '10.1371/journal.pcbi.1014707',
    published_journal: 'PLOS Computational Biology',
    preprint_title:
      'From Sequences to Strategies: Early Detection of New SARS-CoV-2 Variants via Genetic Distance to Reduce Hospitalizations',
    preprint_authors: "Myint, A. P.; D'Avanzo, M.; Cacciapaglia, G.",
    preprint_category: 'epidemiology',
    preprint_date: '2025-09-05',
    published_date: '2026-09-01',
    preprint_abstract:
      'The COVID-19 pandemic highlighted the critical need for robust methods to monitor viral evolution.',
    preprint_author_corresponding: 'Aung Pone Myint',
    preprint_author_corresponding_institution: 'Hospices Civils de Lyon',
  },
  {
    preprint_doi: '10.1101/2025.05.20.25328037',
    published_doi: '10.1080/10641963.2026.2725928',
    published_journal: 'Clinical and Experimental Hypertension',
    preprint_title:
      'Association of Antihypertensive Medication and Steatotic Liver Disease with Liver Fibrosis and Mortality among US Adults',
    preprint_authors: 'Wu, Y.; Fang, F.',
    preprint_category: 'gastroenterology',
    preprint_date: '2025-05-21',
    published_date: '2026-09-07',
    preprint_abstract:
      'Metabolic dysfunction-associated steatotic liver disease and hypertension frequently coexist.',
    preprint_author_corresponding: 'Fei Fang',
    preprint_author_corresponding_institution: 'Yale University',
  },
];

/** The status upstream answers an empty interval, an inverted one, and a cursor at or past the end with. */
export const NO_ARTICLES = { status: 'no articles found for 2026-09-01 2026-09-07' };

/**
 * Live `/publisher/10.7554` rows for journal publication dates 2026-10-01 to
 * 2026-10-02, captured from api.biorxiv.org on 2026-10-23 — exactly the bioRxiv
 * `/pubs` rows of that interval with an eLife journal DOI. Every row carries
 * these six keys and no others: the preprint DOI as `biorxiv_doi`, and no
 * journal name, authors, corresponding author, or abstract.
 */
export const PUBLISHER_ELIFE_ROWS: RawPublishedRecord[] = [
  {
    biorxiv_doi: '10.1101/2025.09.09.675263',
    published_doi: '10.7554/eLife.109426.3',
    preprint_title:
      'Sex-biased expression of enteroendocrine cell-derived hormones contributes to higher fat storage in Drosophila females',
    preprint_category: 'physiology',
    preprint_date: '2025-09-12',
    published_date: '2026-10-01',
  },
  {
    biorxiv_doi: '10.64898/2026.03.07.709930',
    published_doi: '10.7554/eLife.111378',
    preprint_title: 'Genome-wide discovery of cis-regulatory elements in a large genome',
    preprint_category: 'developmental biology',
    preprint_date: '2026-03-08',
    published_date: '2026-10-01',
  },
  {
    biorxiv_doi: '10.1101/2025.08.26.672310',
    published_doi: '10.7554/eLife.108588',
    preprint_title:
      'Bidirectional translocation of actomyosin drives epithelial invagination in ascidian siphon tube morphogenesis',
    preprint_category: 'developmental biology',
    preprint_date: '2025-08-30',
    published_date: '2026-10-01',
  },
  {
    biorxiv_doi: '10.1101/2025.03.26.645547',
    published_doi: '10.7554/eLife.107370',
    preprint_title: 'A cortical-hippocampal communication undergoes rebalancing after new learning',
    preprint_category: 'neuroscience',
    preprint_date: '2025-03-29',
    published_date: '2026-10-01',
  },
  {
    biorxiv_doi: '10.64898/2026.01.27.702099',
    published_doi: '10.7554/eLife.110887',
    preprint_title:
      'Distinct allosteric remodeling of HIV-1 Env dynamics on virions by gp41-directed antibodies reveals two modes of neutralization',
    preprint_category: 'microbiology',
    preprint_date: '2026-01-28',
    published_date: '2026-10-02',
  },
];

/** The status `/publisher` answers an empty interval and a cursor at or past the end with — it names no dates. */
export const PUBLISHER_NO_ARTICLES = { status: 'no articles found' };

/** The status `/publisher` answers a prefix it does not recognize (`10.755`, `10.1`, `abc`) with, alongside no rows. */
export const PUBLISHER_NOT_RECOGNIZED = { status: 'publisher string not recognized' };
