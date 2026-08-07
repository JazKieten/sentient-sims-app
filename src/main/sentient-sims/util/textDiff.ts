export type DiffOp = 'equal' | 'added' | 'removed';

export type WordDiffPart = {
  op: DiffOp;
  text: string;
};

export type DiffLine = {
  op: DiffOp;
  text: string;
  // Word-level breakdown, present when a removed/added line was paired with its
  // counterpart so the changed words inside it can be highlighted
  words?: WordDiffPart[];
};

// Longest common subsequence over two token arrays, returned as the ops needed to turn
// `before` into `after`. Inputs here are single scenes (a handful of lines, a few hundred
// words), so the O(n*m) table is never a concern.
function lcsOps<T>(before: T[], after: T[], isEqual: (a: T, b: T) => boolean): { op: DiffOp; value: T }[] {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = isEqual(before[i], after[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: { op: DiffOp; value: T }[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (isEqual(before[i], after[j])) {
      ops.push({ op: 'equal', value: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ op: 'removed', value: before[i] });
      i += 1;
    } else {
      ops.push({ op: 'added', value: after[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ op: 'removed', value: before[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ op: 'added', value: after[j] });
    j += 1;
  }

  return ops;
}

function tokenizeWords(line: string): string[] {
  return line.split(/(\s+)/).filter((token) => token.length > 0);
}

// Punctuation and case are noise when deciding whether a word survived the rewrite —
// "Sure," → "Sure" should read as unchanged, not as one deletion plus one insertion.
function wordKey(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function diffWords(before: string, after: string): WordDiffPart[] {
  const ops = lcsOps(tokenizeWords(before), tokenizeWords(after), (a, b) => wordKey(a) === wordKey(b));

  const parts: WordDiffPart[] = [];
  ops.forEach(({ op, value }) => {
    const last = parts[parts.length - 1];
    if (parts.length > 0 && last.op === op) {
      last.text += value;
    } else {
      parts.push({ op, text: value });
    }
  });
  return parts.filter((part) => part.text.length > 0);
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Line-level diff of two blocks of text, with word-level detail inside lines that were
 * rewritten rather than added or dropped outright. Blank lines are ignored: the reviewer
 * reflows spacing constantly and that isn't a change worth showing.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = before.split('\n').filter((line) => line.trim().length > 0);
  const afterLines = after.split('\n').filter((line) => line.trim().length > 0);
  const ops = lcsOps(beforeLines, afterLines, (a, b) => normalizeLine(a) === normalizeLine(b));

  const result: DiffLine[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].op === 'equal') {
      result.push({ op: 'equal', text: ops[index].value.trim() });
      index += 1;
      continue;
    }

    // A run of removals immediately followed by additions is a rewrite: pair the lines up
    // positionally so each shows which words actually changed
    const removed: string[] = [];
    while (index < ops.length && ops[index].op === 'removed') {
      removed.push(ops[index].value);
      index += 1;
    }
    const added: string[] = [];
    while (index < ops.length && ops[index].op === 'added') {
      added.push(ops[index].value);
      index += 1;
    }

    const paired = Math.min(removed.length, added.length);
    for (let pair = 0; pair < paired; pair += 1) {
      result.push({
        op: 'removed',
        text: removed[pair].trim(),
        words: diffWords(removed[pair].trim(), added[pair].trim()).filter((part) => part.op !== 'added'),
      });
      result.push({
        op: 'added',
        text: added[pair].trim(),
        words: diffWords(removed[pair].trim(), added[pair].trim()).filter((part) => part.op !== 'removed'),
      });
    }
    removed.slice(paired).forEach((line) => result.push({ op: 'removed', text: line.trim() }));
    added.slice(paired).forEach((line) => result.push({ op: 'added', text: line.trim() }));
  }

  return result;
}

export function hasChanges(diff: DiffLine[]): boolean {
  return diff.some((line) => line.op !== 'equal');
}
