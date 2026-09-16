/**
 * Fuzzy matching for the command palette and global search (§33, §57).
 *
 * §57 fixes the ranking: exact name, then prefix, then fuzzy, then type/path/
 * tags. The weights below implement that order literally, so a query that
 * matches a command's name exactly can never be outranked by one that merely
 * mentions the term in its keywords.
 */

/** Weights per §57's ranking order. Kept apart so the order is inspectable. */
const EXACT = 1000;
const PREFIX = 800;
const SUBSTRING = 600;
const FUZZY = 300;
/** A keyword hit is a lower-confidence signal than a name hit. */
const ALIAS_PENALTY = 0.5;

/**
 * Scores `text` against `query`, or returns `null` when it does not match.
 * Higher is better; an empty query matches everything with score 0.
 */
export function scoreMatch(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return 0;
  }
  const haystack = text.toLowerCase();

  if (haystack === needle) {
    return EXACT;
  }
  if (haystack.startsWith(needle)) {
    // Shorter targets are tighter matches: "Term" beats "Terminal settings".
    return PREFIX - (haystack.length - needle.length);
  }

  const at = haystack.indexOf(needle);
  if (at >= 0) {
    return SUBSTRING - at;
  }

  return scoreSubsequence(haystack, needle);
}

/** In-order character match, rewarding runs of adjacent characters. */
function scoreSubsequence(haystack: string, needle: string): number | null {
  let cursor = 0;
  let bonus = 0;
  let run = 0;

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) {
      return null;
    }
    run = found === cursor ? run + 1 : 0;
    bonus += run;
    cursor = found + 1;
  }

  return FUZZY + bonus * 4 - (haystack.length - needle.length);
}

export type Ranked<T> = { item: T; score: number };

/**
 * Ranks items against a query, best first.
 *
 * `keys` returns the item's primary name and any aliases; the best score of
 * the two wins, aliases discounted. Ties keep the caller's original order,
 * which is why the comparison is not a plain `score` sort.
 */
export function rankItems<T>(
  query: string,
  items: readonly T[],
  keys: (item: T) => { name: string; aliases?: readonly string[] },
): Ranked<T>[] {
  if (query.trim() === "") {
    return items.map((item) => ({ item, score: 0 }));
  }

  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const { name, aliases = [] } = keys(item);
    const candidates = [
      scoreMatch(query, name),
      ...aliases.map((alias) => {
        const score = scoreMatch(query, alias);
        return score === null ? null : score * ALIAS_PENALTY;
      }),
    ].filter((score): score is number => score !== null);

    if (candidates.length > 0) {
      ranked.push({ item, score: Math.max(...candidates) });
    }
  }

  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index)
    .map(({ entry }) => entry);
}
