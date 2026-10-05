// Keyword matching: which of the configured terms an item names, and how the
// terms are put to LinkedIn's search.
//
// LinkedIn's search stems, fuzzes and ranks ("acme" finds "Acme's" and posts
// by people who work at Acme), so a search result is not yet a match: every
// item, whichever page it came from, is matched here again, the same way. A
// keyword matches as a whole word or phrase, case-insensitively, in any
// script: "next" is not found in "nextbrowser", "nextbrowser" is found in
// "nextbrowser.com", and a hashtag counts as a word, so "acme" is found in
// "#acme".

export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 60;
const MIN_KEYWORD_LENGTH = 2;
/** How many terms go into one search query. LinkedIn accepts long boolean
 *  queries but ranks them worse the longer they get. */
export const TERMS_PER_QUERY = 6;

/** normalizeKeyword trims a term, drops surrounding quotes and collapses
 *  inner whitespace. It returns "" for anything too short or too long to be a
 *  useful term. */
export function normalizeKeyword(value: unknown): string {
  const text = String(value ?? "")
    .replace(/^[\s"'“”«»]+|[\s"'“”«»]+$/g, "")
    .replace(/\s+/g, " ");
  if (text.length < MIN_KEYWORD_LENGTH || text.length > MAX_KEYWORD_LENGTH) return "";
  return text;
}

/** normalizeKeywords normalizes a list, drops duplicates regardless of case,
 *  and keeps at most `max`. */
export function normalizeKeywords(values: unknown, max = MAX_KEYWORDS): string[] {
  const out: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const keyword = normalizeKeyword(value);
    if (keyword && !out.some((known) => known.toLowerCase() === keyword.toLowerCase())) out.push(keyword);
    if (out.length >= max) break;
  }
  return out;
}

/** splitKeywords reads a comma- or newline-separated list, as a person types
 *  one. Phrases keep their spaces. */
export function splitKeywords(text: string): string[] {
  return text.split(/[,\n]+/).map(normalizeKeyword).filter(Boolean);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** keywordPattern builds the expression one keyword is found with. The word
 *  boundary is only asked for on a side that is itself a word character, so
 *  "c++" and ".net" still match. */
export function keywordPattern(keyword: string): RegExp {
  const body = keyword.split(" ").map(escape).join("\\s+");
  const before = WORD_CHAR.test(keyword[0] ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
  const after = WORD_CHAR.test(keyword[keyword.length - 1] ?? "") ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(`${before}${body}${after}`, "iu");
}

export type Matcher = (text: string) => string[];

/** keywordMatcher returns the keywords a text names, in configuration order. */
export function keywordMatcher(keywords: string[]): Matcher {
  const patterns = keywords.map((keyword) => ({ keyword, pattern: keywordPattern(keyword) }));
  return (text) => (text ? patterns.filter(({ pattern }) => pattern.test(text)).map(({ keyword }) => keyword) : []);
}

/** searchTerms is what a pass searches for: the company's own names first —
 *  they are always searched — then the keywords, without repeats. */
export function searchTerms(companyNames: string[], keywords: string[]): string[] {
  const terms: string[] = [];
  for (const term of [...companyNames, ...keywords]) {
    if (!terms.some((known) => known.toLowerCase() === term.toLowerCase())) terms.push(term);
  }
  return terms;
}

/** searchQueries groups terms into at most `maxQueries` LinkedIn search
 *  queries, the terms of each joined with OR and phrases quoted, so a pass
 *  asks one search for several terms instead of one each. Terms past
 *  maxQueries × TERMS_PER_QUERY are not searched; they are still matched in
 *  everything else the pass reads. */
export function searchQueries(terms: string[], maxQueries: number): string[] {
  const max = Math.max(0, Math.floor(maxQueries));
  const searched = terms.slice(0, max * TERMS_PER_QUERY);
  if (searched.length === 0) return [];
  const count = Math.min(max, Math.ceil(searched.length / TERMS_PER_QUERY));
  const size = Math.ceil(searched.length / count);
  const queries: string[] = [];
  for (let index = 0; index < searched.length; index += size) {
    const words = searched.slice(index, index + size).map((term) => (/\s/.test(term) ? `"${term.replace(/"/g, "")}"` : term));
    queries.push(words.join(" OR "));
  }
  return queries;
}

/** signature names a term set independently of order and case, so a source
 *  can tell that what it filters for has changed. */
export function signature(terms: string[]): string {
  return terms.map((term) => term.toLowerCase()).sort().join("|");
}
