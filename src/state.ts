// Monitor state and settings: one JSON document the caller owns and persists.
//
// A pass takes the state in and hands the next one back without mutating what
// it was given, so a pass cut short leaves the last saved state intact and
// everything a finished pass learned is in what it returned.

import { accountKey, normalizeAccount, parsePostUrn, type AccountRef } from "./ids.js";
import { MAX_KEYWORDS, normalizeKeywords } from "./keywords.js";
import { DEFAULT_URGENT_TERMS } from "./triage.js";

export interface MonitorSettings {
  /** People and companies to watch: their new posts are reported. Links,
   *  "in/<slug>", "company/<slug>", or {kind, slug}; stored as {kind, slug}. */
  accounts: AccountRef[];
  /** Your own company's names: always searched, and any item that names one
   *  is a company mention. */
  companyNames: string[];
  /** Words and phrases to find: a product, a competitor, the problem you
   *  solve. */
  keywords: string[];
  /** Words that drop an item even when a keyword matched. */
  excludeKeywords: string[];
  /** Terms that make an item urgent; see triage.ts. */
  urgentTerms: string[];
  /** Read the notifications: mentions, comments on your posts, replies to
   *  your comments. */
  watchNotifications: boolean;
  /** Open posts whose comment count grew, or that a new notification points
   *  at, and read their comments. */
  watchComments: boolean;
  /** Search LinkedIn's posts for the company names and keywords, newest
   *  first. */
  searchKeywords: boolean;
  /** How many searches one pass may run; the terms are grouped into this
   *  many queries. */
  maxSearches: number;
  /** How many times a page may be scrolled to get back to what the last
   *  pass saw. */
  maxScrolls: number;
  /** How many posts one pass may open to read their comments. A post past
   *  this is opened on the next pass instead. */
  maxCommentReads: number;
  /** How old an item may be and still be announced. 0 turns the limit off. */
  maxItemAgeMs: number;
  /** Leave the tab on about:blank after a pass. */
  parkTab: boolean;
}

export interface AccountState {
  /** The public id when known, the name otherwise: what a panel shows. */
  handle?: string;
  /** The member's name as LinkedIn drew it. */
  name?: string;
  /** Their public id (/in/<slug>/). */
  slug?: string;
  signedIn: boolean;
  checkedAt: number;
}

/** One thing the monitor reads: the notifications, a watched account's
 *  posts, or one search query. */
export interface SourceState {
  /** When the source was first read with its current filter: nothing created
   *  before it is announced. */
  since: number;
  /** What the source filtered by when `since` was set: a search's term set.
   *  A new set finds other things in the same place, so it starts a new
   *  starting line instead of announcing a day of old matches. */
  filter: string;
  /** The account's name as last drawn. */
  name?: string;
  lastReadAt?: number;
  lastNewAt?: number;
  /** Read through a fallback page on the last pass. */
  fallback?: boolean;
  /** Why the source could not be read on a later pass. */
  note?: string;
}

/** What the monitor last knew about one post, to tell when its comments are
 *  worth reading: only a post whose drawn comment count grew, or that a new
 *  notification points at, is opened. */
export interface PostWatch {
  /** "urn:li:activity:<id>". */
  urn: string;
  /** The source it was found in: "notifications", "account:…", "search:…". */
  source: string;
  /** The account wrote it. */
  own: boolean;
  /** Its comment count when it was last read, or when it was first seen;
   *  absent when only a notification has pointed at it. */
  comments?: number;
  /** A read of its comments is owed: a notification pointed at it, or a pass
   *  that had opened its share left it for the next one. */
  due?: boolean;
  /** When its comments were last read. */
  threadReadAt?: number;
  checkedAt: number;
}

export interface PassRecord {
  at: number;
  finishedAt: number;
  newItems: number;
  urgent: number;
  notes: string[];
}

export interface MonitorState {
  version: 1;
  settings: MonitorSettings;
  account?: AccountState;
  /** Keyed by source: "notifications", "account:person:<slug>",
   *  "account:company:<slug>", "search:<query>" (lowercased). */
  sources: Record<string, SourceState>;
  /** Item keys already seen, newest last, bounded, across every source:
   *  "post:<id>", "comment:<id>", and "notification:<hash>" for the cards. */
  seen: string[];
  /** Keyed by post id. */
  posts: Record<string, PostWatch>;
  lastPass?: PassRecord;
}

export const MAX_ACCOUNTS = 10;
export const MAX_COMPANY_NAMES = 5;
export const MAX_URGENT_TERMS = 50;
export const DEFAULT_MAX_SEARCHES = 2;
export const MAX_SEARCHES = 3;
export const DEFAULT_MAX_SCROLLS = 2;
export const MAX_SCROLLS = 4;
export const DEFAULT_MAX_COMMENT_READS = 4;
export const MAX_COMMENT_READS = 8;
export const DEFAULT_MAX_ITEM_AGE_MS = 72 * 60 * 60 * 1000;
export const MAX_SEEN = 5000;
export const MAX_POSTS_WATCHED = 300;
export const MAX_PASS_NOTES = 6;

export function defaultSettings(): MonitorSettings {
  return {
    accounts: [],
    companyNames: [],
    keywords: [],
    excludeKeywords: [],
    urgentTerms: [...DEFAULT_URGENT_TERMS],
    watchNotifications: true,
    watchComments: true,
    searchKeywords: true,
    maxSearches: DEFAULT_MAX_SEARCHES,
    maxScrolls: DEFAULT_MAX_SCROLLS,
    maxCommentReads: DEFAULT_MAX_COMMENT_READS,
    maxItemAgeMs: DEFAULT_MAX_ITEM_AGE_MS,
    parkTab: true,
  };
}

export function emptyState(settings: Partial<MonitorSettings> | Record<string, unknown> = {}): MonitorState {
  return { version: 1, settings: normalizeSettings(settings), sources: {}, seen: [], posts: {} };
}

function integer(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** normalizeAccounts reads a list of accounts in any form, drops what is
 *  not one and repeats, and keeps at most MAX_ACCOUNTS. */
export function normalizeAccounts(values: unknown): AccountRef[] {
  const accounts: AccountRef[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const account = normalizeAccount(value);
    if (account && !accounts.some((known) => accountKey(known) === accountKey(account))) accounts.push(account);
    if (accounts.length >= MAX_ACCOUNTS) break;
  }
  return accounts;
}

export function normalizeSettings(raw: unknown): MonitorSettings {
  const base = defaultSettings();
  const record = raw && typeof raw === "object" ? (raw as Partial<Record<keyof MonitorSettings, unknown>>) : {};
  return {
    accounts: normalizeAccounts(record.accounts),
    companyNames: normalizeKeywords(record.companyNames, MAX_COMPANY_NAMES),
    keywords: normalizeKeywords(record.keywords, MAX_KEYWORDS),
    excludeKeywords: normalizeKeywords(record.excludeKeywords, MAX_KEYWORDS),
    urgentTerms: Array.isArray(record.urgentTerms) ? normalizeKeywords(record.urgentTerms, MAX_URGENT_TERMS) : base.urgentTerms,
    watchNotifications: flag(record.watchNotifications, base.watchNotifications),
    watchComments: flag(record.watchComments, base.watchComments),
    searchKeywords: flag(record.searchKeywords, base.searchKeywords),
    maxSearches: integer(record.maxSearches, base.maxSearches, 0, MAX_SEARCHES),
    maxScrolls: integer(record.maxScrolls, base.maxScrolls, 0, MAX_SCROLLS),
    maxCommentReads: integer(record.maxCommentReads, base.maxCommentReads, 0, MAX_COMMENT_READS),
    maxItemAgeMs: integer(record.maxItemAgeMs, base.maxItemAgeMs, 0),
    parkTab: flag(record.parkTab, base.parkTab),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** sourceKeyValid tells the keys a source can have. */
function sourceKeyValid(key: string): boolean {
  if (key === "notifications") return true;
  if (key.startsWith("search:")) return key.length > "search:".length;
  const account = /^account:(person|company):(.+)$/.exec(key);
  return !!account && !!normalizeAccount(`${account[1] === "person" ? "in" : "company"}/${account[2]}`);
}

/** normalizeState accepts whatever was on disk, including a file from an
 *  older version or a hand edit, and returns something a pass can run on. */
export function normalizeState(raw: unknown): MonitorState {
  const record = raw && typeof raw === "object" ? (raw as Partial<MonitorState>) : {};
  const state = emptyState(record.settings ?? {});

  const account = record.account;
  if (account && typeof account === "object") {
    const slug = normalizeAccount(`in/${String(account.slug ?? "")}`)?.slug;
    state.account = {
      ...optional("handle", text(account.handle)),
      ...optional("name", text(account.name)),
      ...optional("slug", account.slug ? slug : undefined),
      signedIn: account.signedIn === true,
      checkedAt: finite(account.checkedAt) ?? 0,
    };
  }

  for (const [key, value] of Object.entries(record.sources ?? {})) {
    if (!value || typeof value !== "object" || finite(value.since) === undefined || !sourceKeyValid(key)) continue;
    state.sources[key] = {
      since: value.since,
      filter: typeof value.filter === "string" ? value.filter : "",
      ...optional("name", text(value.name)),
      ...optional("lastReadAt", finite(value.lastReadAt)),
      ...optional("lastNewAt", finite(value.lastNewAt)),
      ...(value.fallback === true ? { fallback: true } : {}),
      ...optional("note", text(value.note)),
    };
  }

  state.seen = Array.isArray(record.seen)
    ? record.seen.filter((key): key is string => typeof key === "string" && !!key).slice(-MAX_SEEN)
    : [];

  const posts = Object.entries(record.posts ?? {})
    .filter(([id, value]) => value && typeof value === "object" && parsePostUrn(value.urn)?.id === id && typeof value.source === "string")
    .sort(([, left], [, right]) => (finite(left.checkedAt) ?? 0) - (finite(right.checkedAt) ?? 0))
    .slice(-MAX_POSTS_WATCHED);
  for (const [id, value] of posts) {
    state.posts[id] = {
      urn: parsePostUrn(value.urn)!.urn,
      source: value.source,
      own: value.own === true,
      ...optional("comments", finite(value.comments)),
      ...(value.due === true ? { due: true } : {}),
      ...optional("threadReadAt", finite(value.threadReadAt)),
      checkedAt: finite(value.checkedAt) ?? 0,
    };
  }

  const pass = record.lastPass;
  if (pass && typeof pass === "object" && finite(pass.at) !== undefined) {
    state.lastPass = {
      at: pass.at,
      finishedAt: finite(pass.finishedAt) ?? pass.at,
      newItems: finite(pass.newItems) ?? 0,
      urgent: finite(pass.urgent) ?? 0,
      notes: Array.isArray(pass.notes) ? pass.notes.filter((note): note is string => typeof note === "string").slice(-MAX_PASS_NOTES) : [],
    };
  }
  return state;
}

/** withSettings applies a settings patch, normalized. Accounts may be given
 *  in any form normalizeAccount reads. */
export function withSettings(state: MonitorState, patch: Partial<MonitorSettings> | Record<string, unknown>): MonitorState {
  return { ...state, settings: normalizeSettings({ ...state.settings, ...patch }) };
}
