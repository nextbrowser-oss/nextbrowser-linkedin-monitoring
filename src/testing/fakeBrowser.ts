// A stand-in linkedin.com for engine tests. The engine labels every evaluate
// with what it reads ("health", "identity", "notifications", "posts",
// "thread", "scroll"), so the fake answers by label and by the page it is on
// instead of running the scripts; the scripts themselves are tested against
// trimmed documents in scripts.test.ts.

import type { MonitorBrowser } from "../browser.js";
import { NOTIFICATIONS_URL, parsePostUrn } from "../ids.js";
import type {
  Gate,
  IdentitySnapshot,
  NotificationsSnapshot,
  PageHealth,
  PostsSnapshot,
  RawComment,
  RawNotification,
  RawPost,
  ThreadSnapshot,
} from "../scripts.js";

export interface FakeAccount {
  name: string;
  /** Newest first; `pageSize` posts are drawn per scroll. */
  posts: RawPost[];
  /** What the activity page (a person's "all" tab, a company's posts) draws. */
  page?: "feed" | "blank" | "empty" | "not_found";
  /** What a person's posts tab draws. */
  shares?: "feed" | "blank";
}

export interface FakeThread {
  post?: RawPost;
  comments: RawComment[];
}

const ACTIVITY = /^https:\/\/www\.linkedin\.com\/in\/([^/]+)\/recent-activity\/(all|shares)\/$/;
const COMPANY = /^https:\/\/www\.linkedin\.com\/company\/([^/]+)\/posts\/\?feedView=all$/;
const SEARCH = /^https:\/\/www\.linkedin\.com\/search\/results\/content\/\?keywords=([^&]+)&sortBy=%22date_posted%22$/;
const POST_PAGE = /^https:\/\/www\.linkedin\.com\/feed\/update\/([^/]+)\/$/;

type Where =
  | { kind: "notifications" }
  | { kind: "account"; account?: FakeAccount; tab: "all" | "shares" }
  | { kind: "search"; query: string }
  | { kind: "post"; id: string }
  | { kind: "other" };

export class FakeLinkedIn implements MonitorBrowser {
  url = "about:blank";
  signedIn = true;
  /** Every page is a /checkpoint/ page. */
  checkpoint = false;
  /** The restriction notice every page shows, when set ("HTTP 999" too). */
  restricted = "";
  /** The search limit notice search pages show, when set. */
  searchLimit = "";
  /** Every page is Chromium's error page with this code, when set. */
  networkError = "";
  name = "Dana Reyes";
  slug = "dana-reyes";
  /** Newest first. */
  notifications: RawNotification[] = [];
  /** Keyed "in/<slug>" or "company/<slug>". */
  accounts: Record<string, FakeAccount> = {};
  /** Every post LinkedIn's search can find, newest first. A query finds the
   *  ones whose text contains any of its terms anywhere, as LinkedIn's fuzzy
   *  search would. */
  searchable: RawPost[] = [];
  /** By post id. */
  threads: Record<string, FakeThread> = {};
  /** Post ids whose thread read throws. */
  readonly failThreads = new Set<string>();
  pageSize = 4;
  scrolled = 0;
  readonly opened: string[] = [];
  readonly labels: string[] = [];

  async open(url: string): Promise<void> {
    this.url = url;
    this.opened.push(url);
    this.scrolled = 0;
  }

  async waitForLoad(): Promise<void> {}

  async evaluate<T>(_script: string, label = ""): Promise<T> {
    this.labels.push(label);
    return this.answer(label) as T;
  }

  /** The posts opened for their comments, by id, in order. */
  get threadsRead(): string[] {
    return this.opened.map((url) => parsePostUrn(POST_PAGE.exec(url)?.[1])?.id).filter((id): id is string => !!id);
  }

  /** The searches run, by query, in order. */
  get searches(): string[] {
    return this.opened.map((url) => SEARCH.exec(url)?.[1]).filter((query): query is string => !!query).map(decodeURIComponent);
  }

  private where(): Where {
    if (this.url === NOTIFICATIONS_URL) return { kind: "notifications" };
    const activity = ACTIVITY.exec(this.url);
    if (activity) {
      const account = this.accounts[`in/${decodeURIComponent(activity[1]!)}`];
      return { kind: "account", tab: activity[2] as "all" | "shares", ...(account ? { account } : {}) };
    }
    const company = COMPANY.exec(this.url);
    if (company) {
      const account = this.accounts[`company/${decodeURIComponent(company[1]!)}`];
      return { kind: "account", tab: "all", ...(account ? { account } : {}) };
    }
    const search = SEARCH.exec(this.url);
    if (search) return { kind: "search", query: decodeURIComponent(search[1]!) };
    const post = POST_PAGE.exec(this.url);
    if (post) return { kind: "post", id: parsePostUrn(post[1])?.id ?? "" };
    return { kind: "other" };
  }

  private gate(): Gate {
    const at = this.where();
    const state = at.kind === "account" ? (at.tab === "all" ? at.account?.page ?? "feed" : at.account?.shares ?? "feed") : "";
    return {
      login_wall: !this.signedIn && !this.checkpoint && !this.networkError,
      checkpoint: this.checkpoint && !this.networkError,
      restricted: this.networkError ? "" : this.restricted,
      search_limit: at.kind === "search" ? this.searchLimit : "",
      unavailable: (at.kind === "account" && (!at.account || state === "not_found")) || (at.kind === "post" && !this.threads[at.id]),
      network_error: this.networkError,
    };
  }

  private searchResults(query: string): RawPost[] {
    const terms = query.split(/\s+OR\s+/).map((term) => term.replace(/"/g, "").toLowerCase());
    return this.searchable.filter((post) => terms.some((term) => post.text.toLowerCase().includes(term)));
  }

  private drawn(): RawPost[] {
    const at = this.where();
    const page = (posts: RawPost[]) => posts.slice(0, this.pageSize * (this.scrolled + 1));
    if (at.kind === "account" && at.account) {
      const state = at.tab === "all" ? at.account.page ?? "feed" : at.account.shares ?? "feed";
      return state === "feed" ? page(at.account.posts) : [];
    }
    if (at.kind === "search" && !this.searchLimit) return page(this.searchResults(at.query));
    return [];
  }

  private cards(): RawNotification[] {
    return this.notifications.slice(0, this.pageSize * (this.scrolled + 1));
  }

  private empty(): boolean {
    const at = this.where();
    if (at.kind === "account") return at.account?.page === "empty" && at.tab === "all";
    if (at.kind === "search") return !this.searchLimit && this.searchResults(at.query).length === 0;
    if (at.kind === "notifications") return this.notifications.length === 0;
    return false;
  }

  private answer(label: string): unknown {
    const gate = this.gate();
    const at = this.where();
    switch (label) {
      case "exists":
        return { found: true };
      case "health": {
        const units = at.kind === "notifications"
          ? this.cards().length
          : at.kind === "post"
            ? (this.threads[at.id]?.comments.length ?? 0) + (this.threads[at.id] ? 1 : 0)
            : this.drawn().length;
        return { url: this.url, rendered: units > 0, units, empty: this.empty(), gate } satisfies PageHealth;
      }
      case "identity":
        return {
          url: this.url,
          gate,
          name: this.signedIn ? this.name : "",
          slug: this.signedIn && this.url.includes("/feed/") && !this.url.includes("/feed/update/") ? this.slug : "",
          chrome: this.signedIn,
        } satisfies IdentitySnapshot;
      case "notifications":
        return { url: this.url, gate, empty: this.empty(), cards: this.cards() } satisfies NotificationsSnapshot;
      case "posts":
        return {
          url: this.url,
          gate,
          name: at.kind === "account" ? at.account?.name ?? "" : "",
          empty: this.empty(),
          posts: this.drawn(),
        } satisfies PostsSnapshot;
      case "scroll": {
        const before = this.scrolled * 600;
        const total = at.kind === "notifications" ? this.notifications.length : at.kind === "account" ? at.account?.posts.length ?? 0 : at.kind === "search" ? this.searchResults(at.query).length : 0;
        if (this.pageSize * (this.scrolled + 1) < total) this.scrolled += 1;
        return { before, after: this.scrolled * 600, height: 10_000 };
      }
      case "thread": {
        if (at.kind !== "post") throw new Error("not on a post");
        if (this.failThreads.has(at.id)) throw new Error("nbc eval failed: Execution context was destroyed");
        const thread = this.threads[at.id];
        const post = thread?.post ?? null;
        return {
          url: this.url,
          gate,
          post,
          comments_text: post?.comments_text ?? "",
          comments: thread?.comments ?? [],
        } satisfies ThreadSnapshot;
      }
      default:
        throw new Error(`the fake has no answer for "${label}"`);
    }
  }
}

/** NOON is when the engine tests' clock starts. */
export const NOON = Date.UTC(2026, 9, 5, 12, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

let serial = 1;

/** linkedInId makes an id the way LinkedIn does: the time in its first 41
 *  bits, a sequence below them. */
export function linkedInId(at: number): string {
  return ((BigInt(at) << 22n) + BigInt(serial++ % 4096)).toString();
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** rawPost builds a post as a feed or a search draws it. Its id says when it
 *  was made: an hour before noon unless the patch says otherwise. */
export function rawPost(author: string, text: string, patch: Partial<RawPost> & { at?: number; company?: boolean } = {}): RawPost {
  const { at, company, ...rest } = patch;
  const kind = company ? "company" : "person";
  return {
    urn: `urn:li:activity:${linkedInId(at ?? NOON - HOUR)}`,
    author,
    author_kind: kind,
    author_slug: slugOf(author),
    author_url: `https://www.linkedin.com/${company ? "company" : "in"}/${slugOf(author)}/`,
    author_headline: company ? "1,234 followers" : `Works at ${author.split(" ")[0]} Co`,
    text,
    truncated: false,
    time_text: "",
    mentions: [],
    comments_text: "",
    reactions_text: "",
    reposts_text: "",
    action_bar: true,
    reshare: false,
    reshared_by: "",
    ...rest,
  };
}

/** rawComment builds a comment as a post's page draws it. */
export function rawComment(post: RawPost, author: string, text: string, patch: Partial<RawComment> & { at?: number } = {}): RawComment {
  const { at, ...rest } = patch;
  const postId = parsePostUrn(post.urn)!.id;
  return {
    urn: `urn:li:comment:(activity:${postId},${linkedInId(at ?? NOON - HOUR)})`,
    parent_urn: "",
    author,
    author_kind: "person",
    author_url: `https://www.linkedin.com/in/${slugOf(author)}/`,
    author_headline: "",
    text,
    time_text: "",
    mentions: [],
    replies_text: "",
    ...rest,
  };
}

/** rawNotification builds a card. With a comment, it links the comment. */
export function rawNotification(actor: string, headline: string, post: RawPost, patch: Partial<RawNotification> & { comment?: RawComment; reply?: RawComment } = {}): RawNotification {
  const { comment, reply, ...rest } = patch;
  const commentUrn = (reply ? reply.parent_urn : comment?.urn) ?? "";
  return {
    headline,
    snippet: "",
    actor,
    actor_kind: "person",
    actor_url: `https://www.linkedin.com/in/${slugOf(actor)}/`,
    post_urn: post.urn,
    comment_urn: commentUrn,
    reply_urn: reply?.urn ?? "",
    time_text: "",
    link: `https://www.linkedin.com/feed/update/${post.urn}/`,
    ...rest,
  };
}
