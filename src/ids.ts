// LinkedIn post, comment and account ids, and the links built from them.
//
// LinkedIn names a post by a URN: urn:li:activity:<id> for an activity (a
// post, a repost, a comment shared to the feed), urn:li:share:<id> and
// urn:li:ugcPost:<id> for the content behind it. The feed and search mark
// each post's container with one of them (data-urn), and a post's own page is
// /feed/update/<urn>/. The ids are 19-digit numbers, too wide for a
// JavaScript number, so they are kept as strings.
//
// They also carry the time. Like the ids of most large sites, a LinkedIn id
// starts with the moment it was made: its first 41 bits are milliseconds since
// the Unix epoch, so `BigInt(id) >> 22n` is when the post or the comment was
// created. That is better than anything LinkedIn draws beside it ("3h",
// "1w"), and it is what decides whether something is new (see engine.ts). A
// value outside the years LinkedIn has existed in is not a time and is not
// used.
//
// A comment is urn:li:comment:(activity:<post>,<comment>) — the post it is on
// and its own id — and a link to it is the post's link with ?commentUrn=. A
// reply is a comment whose link also carries &replyUrn=.
//
// People are /in/<public id>/ and companies /company/<slug>/; either is what
// the monitor calls an account.

export type UrnKind = "activity" | "share" | "ugcPost";

/** A post's URN, split. */
export interface PostRef {
  kind: UrnKind;
  /** The numeric id, as a string. */
  id: string;
  /** "urn:li:<kind>:<id>". */
  urn: string;
}

/** A comment's URN, split. */
export interface CommentRef {
  /** The post it is on. */
  post: PostRef;
  /** The comment's own id. */
  id: string;
}

export type AccountKind = "person" | "company";

/** A watched account: a person (/in/<slug>/) or a company (/company/<slug>/). */
export interface AccountRef {
  kind: AccountKind;
  slug: string;
}

const ID = /^\d{6,25}$/;
const POST_URN = /urn(?::|%3A)li(?::|%3A)(activity|share|ugcPost)(?::|%3A)(\d{6,25})/i;
const POST_SLUG = /-(activity|share|ugcPost)-(\d{6,25})-/i;
const COMMENT_URN = /urn:li:comment:\((?:urn:li:)?(activity|share|ugcPost):(\d{6,25}),(\d{6,25})\)/i;
const REPLY_URN = /urn:li:comment:\(urn:li:comment:\((?:urn:li:)?(activity|share|ugcPost):(\d{6,25}),\d{6,25}\),(\d{6,25})\)/i;
/** A person's public id: letters (any script), digits, hyphens; LinkedIn
 *  allows 3 to 100 characters. */
const PERSON_SLUG = /^[\p{L}\p{N}][\p{L}\p{N}_-]{1,99}$/u;
/** A company's slug, or its numeric id. */
const COMPANY_SLUG = /^[\p{L}\p{N}][\p{L}\p{N}_.&'-]{0,99}$/u;

/** The first and last moments a LinkedIn id can name: LinkedIn's activity
 *  ids took this shape long after 2010, and nothing it makes is dated a
 *  century ahead. */
const EARLIEST_ID_TIME = Date.UTC(2010, 0, 1);
const LATEST_ID_TIME = Date.UTC(2100, 0, 1);

function kindOf(raw: string): UrnKind {
  const lower = raw.toLowerCase();
  return lower === "ugcpost" ? "ugcPost" : lower === "share" ? "share" : "activity";
}

function postRef(kind: string, id: string): PostRef {
  const normalized = kindOf(kind);
  return { kind: normalized, id, urn: `urn:li:${normalized}:${id}` };
}

/** parsePostUrn reads a post's URN out of anything that carries one: the URN
 *  itself, a /feed/update/<urn>/ link (URN-encoded or not), or a
 *  /posts/<author>_<words>-activity-<id>-<code>/ link. */
export function parsePostUrn(value: unknown): PostRef | undefined {
  const text = String(value ?? "");
  const urn = POST_URN.exec(text);
  if (urn) return postRef(urn[1] ?? "", urn[2] ?? "");
  const slug = POST_SLUG.exec(text);
  if (slug && /\/posts\//.test(text)) return postRef(slug[1] ?? "", slug[2] ?? "");
  return undefined;
}

/** parseCommentUrn reads a comment's URN, plain or URN-encoded, in either of
 *  the forms LinkedIn writes it: (activity:<post>,<id>) and
 *  (urn:li:activity:<post>,<id>). A reply written as a comment inside a
 *  comment is read as its own id on the post. */
export function parseCommentUrn(value: unknown): CommentRef | undefined {
  let text = String(value ?? "");
  try {
    text = decodeURIComponent(text);
  } catch {
    /* keep it as it was */
  }
  const match = REPLY_URN.exec(text) ?? COMMENT_URN.exec(text);
  if (!match) return undefined;
  return { post: postRef(match[1] ?? "", match[2] ?? ""), id: match[3] ?? "" };
}

/** timeFromId is when a LinkedIn id was made, or undefined for anything that
 *  does not decode to a plausible time. */
export function timeFromId(id: string | undefined): number | undefined {
  if (!id || !ID.test(id)) return undefined;
  const ms = Number(BigInt(id) >> 22n);
  return ms >= EARLIEST_ID_TIME && ms < LATEST_ID_TIME ? ms : undefined;
}

/** postUrl is the link to a post. Activity URNs are what the feed carries;
 *  share and ugcPost URNs open the same way. */
export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

/** commentUrn is the URN of a comment on a post. */
export function commentUrn(post: PostRef, id: string): string {
  return `urn:li:comment:(${post.kind}:${post.id},${id})`;
}

/** encodeUrn writes a URN the way LinkedIn's own links do, parentheses and
 *  all. */
function encodeUrn(urn: string): string {
  return encodeURIComponent(urn).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** commentUrl is the link to one comment: LinkedIn opens the post and
 *  scrolls to it. A reply is linked through the comment it answers. */
export function commentUrl(post: PostRef, id: string, parentId?: string): string {
  const base = `${postUrl(post.urn)}?commentUrn=${encodeUrn(commentUrn(post, parentId || id))}`;
  return parentId ? `${base}&replyUrn=${encodeUrn(commentUrn(post, id))}` : base;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
}

/** normalizeAccount accepts an account in any form a person pastes it — a
 *  profile or company link, "in/<slug>", "company/<slug>", "person:<slug>",
 *  "company:<slug>", or a {kind, slug} object — and returns it, or undefined
 *  for anything that cannot be one. A bare slug is taken as a person: people
 *  are what B2B monitoring watches most. */
export function normalizeAccount(value: unknown): AccountRef | undefined {
  if (value && typeof value === "object") {
    const record = value as Partial<AccountRef>;
    return normalizeAccount(`${record.kind === "company" ? "company" : "in"}/${String(record.slug ?? "")}`);
  }
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  let kind: AccountKind = "person";
  let slug = "";
  const link = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/(in|company|showcase)\/([^/?#\s]+)/i.exec(text);
  const short = /^(in|company|person|showcase)[/:]([^/?#\s]+)\/?$/i.exec(text);
  if (link) {
    kind = link[1]!.toLowerCase() === "in" ? "person" : "company";
    slug = link[2] ?? "";
  } else if (short) {
    const prefix = short[1]!.toLowerCase();
    kind = prefix === "in" || prefix === "person" ? "person" : "company";
    slug = short[2] ?? "";
  } else if (/^@?[^/:?#\s]+$/.test(text)) {
    slug = text.replace(/^@/, "");
  } else {
    return undefined;
  }
  slug = decode(slug);
  const valid = kind === "person" ? PERSON_SLUG.test(slug) && slug.length >= 3 : COMPANY_SLUG.test(slug);
  return valid ? { kind, slug } : undefined;
}

/** accountFromUrl reads the account a link points at: /in/<slug> or
 *  /company/<slug>, on linkedin.com, and nothing else. */
export function accountFromUrl(href: string): AccountRef | undefined {
  let url: URL;
  try {
    url = new URL(href, "https://www.linkedin.com/");
  } catch {
    return undefined;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return undefined;
  const path = /^\/(in|company)\/([^/?#]+)/i.exec(url.pathname);
  return path ? normalizeAccount(`${path[1]}/${path[2]}`) : undefined;
}

/** accountKey is how a watched account is keyed in the state: case does not
 *  tell two slugs apart. */
export function accountKey(account: AccountRef): string {
  return `account:${account.kind}:${account.slug.toLowerCase()}`;
}

/** accountLabel is how an account is written for a person: "in/<slug>" or
 *  "company/<slug>", the shape of its link. */
export function accountLabel(account: AccountRef): string {
  return `${account.kind === "person" ? "in" : "company"}/${account.slug}`;
}

/** accountUrl is the account's own page. */
export function accountUrl(account: AccountRef): string {
  return `https://www.linkedin.com/${account.kind === "person" ? "in" : "company"}/${encodeURIComponent(account.slug)}/`;
}

/** activityUrl is where an account's newest posts are drawn, newest first: a
 *  person's recent activity (posts, reposts and the comments they shared),
 *  or a company's posts. feedView=all keeps a company page from showing only
 *  its "Top" posts, which reorders old posts above new ones. */
export function activityUrl(account: AccountRef): string {
  return account.kind === "person"
    ? `${accountUrl(account)}recent-activity/all/`
    : `${accountUrl(account)}posts/?feedView=all`;
}

/** sharesUrl is a person's own posts only, the fallback when the "all" tab
 *  draws nothing: it is a lighter page, and LinkedIn draws it more reliably. */
export function sharesUrl(account: AccountRef): string {
  return `${accountUrl(account)}recent-activity/shares/`;
}

/** searchUrl is LinkedIn's post search for a query, newest first. Without
 *  sortBy LinkedIn ranks by relevance, and a week-old post ranks above one
 *  from this morning. */
export function searchUrl(query: string): string {
  return `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&sortBy=%22date_posted%22`;
}

/** Every notification, not only the ones LinkedIn picked as relevant. */
export const NOTIFICATIONS_URL = "https://www.linkedin.com/notifications/?filter=all";
