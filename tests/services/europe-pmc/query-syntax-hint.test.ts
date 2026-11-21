/**
 * @fileoverview Advisory diagnostics for zero-hit Europe PMC keyword searches.
 * @module tests/services/europe-pmc/query-syntax-hint.test
 */
import { describe, expect, it } from 'vitest';
import { querySyntaxHint } from '@/services/europe-pmc/query-syntax-hint.js';

describe('querySyntaxHint', () => {
  it.each([
    ['(Drosophila', /parenthesis/i, '(Drosophila)'],
    ['Drosophila)', /parenthesis/i, 'Drosophila'],
    ['TITLE:"fruit fly', /quote/i, 'TITLE:"fruit fly"'],
    ['Drosophila OR', /operator/i, 'Drosophila'],
    ['AND Drosophila', /operator/i, 'Drosophila'],
    ['"prime editing" NOT', /operator/i, '"prime editing"'],
    ['fruit OR (AND fly)', /operator/i, 'fruit OR (fly)'],
    ['fruit OR (fly AND)', /operator/i, 'fruit OR (fly)'],
    ['fruit OR OR fly', /operator/i, 'fruit OR fly'],
    ['fruit NOT NOT fly', /operator/i, 'fruit NOT fly'],
  ] as const)('offers a repair for %s', (query, defect, repair) => {
    const hint = querySyntaxHint(query);
    expect(hint).toMatch(defect);
    expect(hint).toContain(`Try ${repair}`);
  });

  it.each([
    ['()', /empty group/i],
    ['( ( ) )', /empty group/i],
    ['AUTH:', /value.*AUTH:/i],
    ['(TITLE:)', /value.*TITLE:/i],
    ['AUTH: OR fruit', /value.*AUTH:/i],
    ['OR', /operand/i],
    [')', /parenthesis/i],
    ['(', /operand/i],
    ['(OR)', /operand/i],
  ] as const)('asks for missing input in %s', (query, problem) => {
    expect(querySyntaxHint(query)).toMatch(problem);
    expect(querySyntaxHint(query)).not.toContain('Try ');
  });

  it.each([
    'rareterm',
    'NOT fruit',
    'fruit AND NOT fly',
    'fruit OR NOT fly',
    'TITLE: fly',
    'TITLE:(fruit OR fly)',
    '((fruit))',
    'fruit and',
    '"OR (" OR fly',
    String.raw`"a \"quoted\" (term" AND fly`,
    String.raw`fruit\) OR fly`,
    String.raw`rare\: OR fly`,
    'FIRST_PDATE:[2021-01-01 TO 2023-01-01]',
    'TITEL:"fruit fly"',
    'IL6:receptor',
    'FLOOR',
    'SAND',
    '"" OR fly',
  ])('leaves valid or unrecognized syntax alone: %s', (query) => {
    expect(querySyntaxHint(query)).toBeUndefined();
  });
});
