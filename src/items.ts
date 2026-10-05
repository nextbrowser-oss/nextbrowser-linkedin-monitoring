// What the monitor reports about one post or comment, with enough context to
// review it without opening LinkedIn: who wrote it and what they do, what
// they wrote, the post it belongs to, and a direct link.
//
// Everything here is pure: it turns what a page drew into posts and items.

import { commentCount, reactionCount } from "./counts.js";
import {
  accountFromUrl,
  commentUrl,
  parseCommentUrn,
  parsePostUrn,
  postUrl,
  timeFromId,
  type AccountKind,
  type PostRef,
} from "./ids.js";
import { keywordPattern } from "./keywords.js";
import type { RawComment, RawMention, RawNotification, RawPost } from "./scripts.js";
import { cleanTimeLabel, drawnTimeRange, type TimeRange } from "./times.js";

export type ItemKind = "post" | "comment";

/** How an item concerns the monitored account. */
export type Addressed = "mention" | "reply" | "comment_on_post";

/** The post an item belongs to, for context. */
export interface PostContext {
  /** The post's numeric id. */
  id: string;
  /** "urn:li:activity:<id>". */
  urn: string;
  url: string;
  /** Its author, when known: a notification about a comment does not draw
   *  the post, and the post is only read when its comments are. */
  author: string;
  authorUrl?: string;
  /** The text's opening, cut to 200 characters. */
  text?: string;
}

/** The comment a reply answers. */
export interface ParentContext {
  id: string;
  author: string;
  text?: string;
}

export interface LinkedInItem {
  /** "post:<id>" or "comment:<id>": unique across sources, so the same post
   *  found by a notification and by a search is one item. */
  key: string;
  id: string;
  kind: ItemKind;
  author: string;
  /** "person" or "company". */
  authorKind?: AccountKind;
  /** What the author does, as LinkedIn draws it under their name: "Head of
   *  Operations at Foo". */
  authorHeadline?: string;
  /** Their profile or company page. */
  authorUrl?: string;
  /** A post's or a comment's text, cut to 2,000 characters. For a
   *  notification whose post or comment was not opened, what the card says. */
  text: string;
  /** LinkedIn cut the text short behind "…more"; the rest is on the page. */
  truncated?: boolean;
  /** A direct link: the post, or the comment on it. */
  url: string;
  /** The post itself, or the post a comment is on. */
  post: PostContext;
  /** For a reply: the comment it answers. */
  parent?: ParentContext;
  /** Milliseconds since the epoch: from the id when it carries the time,
   *  otherwise the earliest time the drawn label allows. */
  createdAt?: number;
  /** The time as LinkedIn drew it: "3h", "1w". */
  timeText?: string;
  reactions?: number;
  /** A post's comment count, or a comment's reply count. */
  replies?: number;
  reposts?: number;
  /** A repost; `resharedBy` names who reposted it when the author is the
   *  original poster. */
  reshare?: boolean;
  resharedBy?: string;
  /** How it concerns the monitored account, when it does. */
  addressed?: Addressed;
  /** Which of your company names it names, when it names one. */
  company?: string;
}

/** A post read from a page, normalized. */
export interface LinkedInPost {
  key: string;
  ref: PostRef;
  url: string;
  author: string;
  authorKind?: AccountKind;
  authorSlug?: string;
  authorUrl?: string;
  authorHeadline?: string;
  text: string;
  truncated: boolean;
  timeText?: string;
  /** When it was created, from its id. */
  createdAt?: number;
  /** When it can have been created, from the drawn time. */
  range?: TimeRange;
  mentions: RawMention[];
  /** The drawn comment count; 0 when the action bar is drawn with no count
   *  beside it; undefined when neither could be read. */
  comments?: number;
  reactions?: number;
  reposts?: number;
  reshare: boolean;
  resharedBy?: string;
}

/** The monitored account, as far as the pages said. */
export interface Account {
  name?: string;
  slug?: string;
}

const CONTEXT_TEXT = 200;

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined || value === "" ? {} : { [key]: value }) as { [P in K]?: V };
}

function kindOf(value: unknown): AccountKind | undefined {
  return value === "person" || value === "company" ? value : undefined;
}

/** normalizePosts turns what a page reported into posts, in page order. Links
 *  are rebuilt from the URN, so a post is linked the same way wherever it was
 *  found. */
export function normalizePosts(raw: RawPost[], readAt: number): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  const keys = new Set<string>();
  for (const entry of raw ?? []) {
    const ref = parsePostUrn(entry?.urn);
    if (!ref || keys.has(ref.id)) continue;
    keys.add(ref.id);
    const timeText = cleanTimeLabel(entry.time_text);
    const range = drawnTimeRange(timeText, readAt);
    const comments = commentCount(entry.comments_text) ?? (entry.action_bar ? 0 : undefined);
    const authorUrl = String(entry.author_url ?? "").trim();
    const author = accountFromUrl(authorUrl);
    posts.push({
      key: `post:${ref.id}`,
      ref,
      url: postUrl(ref.urn),
      author: String(entry.author ?? "").trim(),
      ...optional("authorKind", kindOf(entry.author_kind) ?? author?.kind),
      ...optional("authorSlug", author?.slug),
      ...optional("authorUrl", authorUrl || undefined),
      ...optional("authorHeadline", String(entry.author_headline ?? "").trim() || undefined),
      text: String(entry.text ?? "").trim(),
      truncated: !!entry.truncated,
      ...optional("timeText", timeText || undefined),
      ...optional("createdAt", timeFromId(ref.id) ?? range?.earliest),
      ...optional("range", range),
      mentions: Array.isArray(entry.mentions) ? entry.mentions.filter((mention) => mention && mention.name) : [],
      ...optional("comments", comments),
      ...optional("reactions", reactionCount(entry.reactions_text)),
      ...optional("reposts", commentCount(entry.reposts_text)),
      reshare: !!entry.reshare,
      ...optional("resharedBy", String(entry.reshared_by ?? "").trim() || undefined),
    });
  }
  return posts;
}

/** postContext describes a post for the items on it. */
export function postContext(post: LinkedInPost): PostContext {
  const text = post.text.replace(/\s+/g, " ").trim().slice(0, CONTEXT_TEXT);
  return {
    id: post.ref.id,
    urn: post.ref.urn,
    url: post.url,
    author: post.author,
    ...optional("authorUrl", post.authorUrl),
    ...optional("text", text || undefined),
  };
}

/** bareContext describes a post the monitor knows only by its URN. */
export function bareContext(ref: PostRef, author = ""): PostContext {
  return { id: ref.id, urn: ref.urn, url: postUrl(ref.urn), author };
}

/** postItem reports a post itself. */
export function postItem(post: LinkedInPost, addressed?: Addressed, company?: string): LinkedInItem {
  return {
    key: post.key,
    id: post.ref.id,
    kind: "post",
    author: post.author,
    ...optional("authorKind", post.authorKind),
    ...optional("authorHeadline", post.authorHeadline),
    ...optional("authorUrl", post.authorUrl),
    text: post.text,
    ...(post.truncated ? { truncated: true } : {}),
    url: post.url,
    post: postContext(post),
    ...optional("createdAt", post.createdAt),
    ...optional("timeText", post.timeText),
    ...optional("reactions", post.reactions),
    ...optional("replies", post.comments),
    ...optional("reposts", post.reposts),
    ...(post.reshare ? { reshare: true } : {}),
    ...optional("resharedBy", post.resharedBy),
    ...(addressed ? { addressed } : {}),
    ...optional("company", company),
  };
}

/** commentKey identifies a comment: by its id, and when the page drew no id,
 *  by the post, the author and the text, which is the same on every read. */
export function commentKey(raw: Pick<RawComment, "urn" | "author" | "text">, postId: string): string {
  const ref = parseCommentUrn(raw.urn);
  return ref ? `comment:${ref.id}` : `comment:${postId}:${hash(`${raw.author}\n${raw.text}`)}`;
}

/** commentItem reports a comment or a reply on a post. */
export function commentItem(
  raw: RawComment,
  post: PostContext,
  readAt: number,
  options: { addressed?: Addressed; company?: string; parent?: ParentContext } = {},
): LinkedInItem | undefined {
  const text = String(raw.text ?? "").trim();
  if (!text || !raw.author) return undefined;
  const ref = parseCommentUrn(raw.urn);
  const parent = parseCommentUrn(raw.parent_urn);
  const timeText = cleanTimeLabel(raw.time_text);
  const range = drawnTimeRange(timeText, readAt);
  const key = commentKey(raw, post.id);
  const postRef: PostRef = { kind: (parsePostUrn(post.urn)?.kind ?? "activity"), id: post.id, urn: post.urn };
  const authorUrl = String(raw.author_url ?? "").trim();
  return {
    key,
    id: ref?.id || key.slice("comment:".length),
    kind: "comment",
    author: raw.author.trim(),
    ...optional("authorKind", kindOf(raw.author_kind) ?? accountFromUrl(authorUrl)?.kind),
    ...optional("authorHeadline", String(raw.author_headline ?? "").trim() || undefined),
    ...optional("authorUrl", authorUrl || undefined),
    text,
    url: ref ? commentUrl(postRef, ref.id, parent?.id) : post.url,
    post,
    ...(options.parent ? { parent: options.parent } : {}),
    ...optional("createdAt", timeFromId(ref?.id) ?? range?.earliest),
    ...optional("timeText", timeText || undefined),
    ...optional("replies", commentCount(raw.replies_text)),
    ...(options.addressed ? { addressed: options.addressed } : {}),
    ...optional("company", options.company),
  };
}

/** What a notification card is about, as far as its link and its words say. */
export interface NotificationReading {
  /** Why it is skipped: it links no post, or it is a reaction, a view, a
   *  birthday, a job alert — nothing to answer. */
  skip?: string;
  /** The post it links. */
  post?: PostRef;
  /** It is about the account's own post: comments on it are addressed to
   *  the account. */
  ownPost: boolean;
  /** The item it reports, when it reports one. A card that only says "… and
   *  3 others commented on your post", with no comment linked, reports none:
   *  the comments are read from the post. */
  item?: LinkedInItem;
}

const MENTION = /\b(?:mentioned|tagged) you\b/i;
const REPLY = /\b(?:replied to (?:your comment|you)|commented on your comment)\b/i;
const ON_YOUR_POST = /\bcommented on your (?:post|article|photo|video|repost|update|poll|document)\b/i;
/** What LinkedIn notifies about that nobody needs to answer. */
const NOTHING_TO_ANSWER = /\b(?:reacted|liked|likes|loves|celebrat\w*|support(?:s|ed)|finds? .{0,40}(?:insightful|funny)|found .{0,40}(?:insightful|funny)|is curious|reposted|shared your|viewed|appeared in|birthday|anniversary|new (?:job|position|role)|started a new|job alerts?|is hiring|jobs? (?:for you|you may)|followed you|follows you|started following|connection request|accepted your|endorsed|congratulat\w*|trending|recommended for you|you may (?:like|know)|new followers?|newsletter|is live|posted:?|shared a post|shared an article)\b/i;

/** readNotification reads one card. It is told apart by its link first — a
 *  comment linked, a reply linked — which holds in any language, and by its
 *  English verbs after that. */
export function readNotification(raw: RawNotification, account: Account, readAt: number): NotificationReading {
  const post = parsePostUrn(raw.post_urn);
  if (!post) return { ownPost: false, skip: "links no post" };
  const headline = String(raw.headline ?? "").replace(/\s+/g, " ").trim();
  const comment = parseCommentUrn(raw.comment_urn);
  const reply = parseCommentUrn(raw.reply_urn);
  let addressed: Addressed | undefined;
  let ownPost = false;
  if (reply || REPLY.test(headline)) {
    addressed = "reply";
  } else if (MENTION.test(headline)) {
    addressed = "mention";
  } else if (ON_YOUR_POST.test(headline)) {
    addressed = "comment_on_post";
    ownPost = true;
  } else if (NOTHING_TO_ANSWER.test(headline)) {
    return { post, ownPost: false, skip: "nothing to answer" };
  }
  const target = reply ?? comment;
  // A card about comments that links none — "Mila Novak and 3 others
  // commented on your post" — reports nothing itself.
  if (!target && addressed && addressed !== "mention") return { post, ownPost };
  const timeText = cleanTimeLabel(raw.time_text);
  const range = drawnTimeRange(timeText, readAt);
  const authorUrl = String(raw.actor_url ?? "").trim();
  const text = String(raw.snippet ?? "").trim() || headline;
  const context = bareContext(post, ownPost ? account.name ?? "" : "");
  const item: LinkedInItem = target
    ? {
      key: `comment:${target.id}`,
      id: target.id,
      kind: "comment",
      author: String(raw.actor ?? "").trim(),
      ...optional("authorKind", kindOf(raw.actor_kind)),
      ...optional("authorUrl", authorUrl || undefined),
      text,
      url: commentUrl(post, target.id, reply && comment && comment.id !== reply.id ? comment.id : undefined),
      post: context,
      ...optional("createdAt", timeFromId(target.id) ?? range?.earliest),
      ...optional("timeText", timeText || undefined),
      ...(addressed ? { addressed } : {}),
    }
    : {
      key: `post:${post.id}`,
      id: post.id,
      kind: "post",
      author: String(raw.actor ?? "").trim(),
      ...optional("authorKind", kindOf(raw.actor_kind)),
      ...optional("authorUrl", authorUrl || undefined),
      text,
      url: postUrl(post.urn),
      post: { ...context, author: String(raw.actor ?? "").trim() },
      ...optional("createdAt", timeFromId(post.id) ?? range?.earliest),
      ...optional("timeText", timeText || undefined),
      ...(addressed ? { addressed } : {}),
    };
  return { post, ownPost, item };
}

/** notificationKey names a card by what it says and links, so a card
 *  LinkedIn rewrites in place ("… and 4 others commented") is new again. */
export function notificationKey(raw: RawNotification): string {
  return `notification:${hash(`${raw.post_urn}\n${raw.comment_urn}\n${raw.reply_urn}\n${String(raw.headline ?? "").replace(/\s+/g, " ").trim()}`)}`;
}

/** isOwn says whether the monitored account wrote something: by the profile
 *  link when the page linked one and the account's public id is known, by
 *  name otherwise. */
export function isOwn(author: { author: string; authorUrl?: string }, account: Account): boolean {
  const linked = author.authorUrl ? accountFromUrl(author.authorUrl) : undefined;
  if (account.slug && linked) return linked.kind === "person" && linked.slug.toLowerCase() === account.slug.toLowerCase();
  return !!account.name && author.author.trim().toLowerCase() === account.name.trim().toLowerCase();
}

/** mentionsAccount says whether a text mentions the account: a tag that
 *  links to its profile, a tag drawn with its name, or its full name in plain
 *  text. A first name alone is not enough: it is half the industry's. */
export function mentionsAccount(text: string, mentions: RawMention[], account: Account): boolean {
  const slug = account.slug?.toLowerCase();
  if (slug && mentions.some((mention) => mention.kind === "person" && mention.slug.toLowerCase() === slug)) return true;
  const name = account.name?.trim();
  if (!name || name.length < 3) return false;
  if (mentions.some((mention) => mention.name.trim().toLowerCase() === name.toLowerCase())) return true;
  return keywordPattern(name.replace(/\s+/g, " ")).test(text);
}

/** hash is a short, stable name for a string (FNV-1a). */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}
