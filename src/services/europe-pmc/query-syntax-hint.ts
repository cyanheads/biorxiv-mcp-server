/**
 * @fileoverview Recovery hints for empty Europe PMC keyword searches.
 * @module services/europe-pmc/query-syntax-hint
 */

const operator = /^(?:AND|OR|NOT)$/;
const field = /^[A-Za-z_][A-Za-z_0-9]*:$/;

interface Diagnosis {
  message: string;
  repair?: string;
}

function diagnose(query: string): Diagnosis | undefined {
  let depth = 0;
  let previous = '';
  let previousStart = 0;

  const removeOperator = (start: number, word: string) => {
    const before = query.slice(0, start).trimEnd();
    const after = query.slice(start + word.length).trimStart();
    const space = before && after && !before.endsWith('(') && !after.startsWith(')') ? ' ' : '';
    const repair = before + space + after;
    return { message: `The ${word} operator needs a search operand.`, repair };
  };

  for (let i = 0; i < query.length; ) {
    if (/\s/.test(query.charAt(i))) {
      i++;
      continue;
    }
    const start = i;
    if (query[i] === '(' || query[i] === ')') {
      i++;
    } else {
      // Quotes, ranges and backslash escapes can contain literal operators or parentheses.
      let terminator = '';
      while (i < query.length) {
        const ch = query.charAt(i);
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (terminator) {
          if (ch === terminator) terminator = '';
        } else if (ch === '"' || ch === '[' || ch === '{') {
          terminator = ch === '[' ? ']' : ch === '{' ? '}' : '"';
        } else if (ch === '(' || ch === ')' || /\s/.test(ch)) {
          break;
        }
        i++;
      }
      if (terminator === '"')
        return { message: 'The quoted phrase is missing its closing quote.', repair: `${query}"` };
      if (terminator) return undefined;
    }

    const word = query.slice(start, i);
    const isOperator = operator.test(word);
    const previousIsOperator = operator.test(previous);
    if (field.test(previous) && (word === ')' || isOperator)) {
      return { message: `Supply a search value after ${previous}` };
    }
    if (word === '(') depth++;
    if (word === ')') {
      if (!depth)
        return {
          message: 'Remove the unmatched closing parenthesis.',
          repair: (query.slice(0, start) + query.slice(i)).trim(),
        };
      if (previous === '(')
        return {
          message:
            'The query contains an empty group. Supply a search term inside the parentheses.',
        };
      if (previousIsOperator) return removeOperator(previousStart, previous);
      depth--;
    }
    if (isOperator && word !== 'NOT' && (!previous || previous === '(')) {
      return removeOperator(start, word);
    }
    // NOT can start an operand after AND or OR.
    if (isOperator && previousIsOperator && (word !== 'NOT' || previous === 'NOT')) {
      return removeOperator(start, word);
    }
    previous = word;
    previousStart = start;
  }
  if (field.test(previous)) return { message: `Supply a search value after ${previous}` };
  if (operator.test(previous)) return removeOperator(previousStart, previous);
  if (previous === '(')
    return { message: 'Supply an operand and a closing parenthesis for the unfinished group.' };
  if (depth)
    return { message: 'A closing parenthesis is missing.', repair: query + ')'.repeat(depth) };
  return undefined;
}

/** Explain an unambiguous syntax defect after Europe PMC has reported zero hits. */
export function querySyntaxHint(query: string): string | undefined {
  const problem = diagnose(query);
  if (!problem) return undefined;
  // A single edit can expose another defect, such as an empty group after removing OR.
  return problem.repair && !diagnose(problem.repair)
    ? `${problem.message} Try ${problem.repair}`
    : problem.message;
}
