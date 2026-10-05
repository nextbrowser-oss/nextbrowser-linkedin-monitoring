// One monitoring pass: who is signed in, what the notifications say about the
// account, what the watched people and companies posted, which new posts
// name your company or a keyword, which comments landed under the posts that
// concern the account, and how urgent each one is.
//
// The pass is a state machine over an explicit MonitorState, like the X,
// Reddit, Instagram and Facebook monitors: state in, next state and events
// out, nothing mutated. The caller persists the state and schedules the next
// pass.
//
// Everything is read, nothing is done: no reaction, no comment, no reply, no
// connection request, not even a click on "…more". Answering is the reply
// agent's job, with the person's approval.
//
// LinkedIn is read from the pages it draws, which makes every read a page
// load, and LinkedIn restricts an account that loads pages like a script
// faster than any other site these monitors read. So the pass is slow on
// purpose: a pause of six to fourteen seconds before every page, a few
// seconds between scrolls, two scrolls per page, two searches and four posts
// opened for their comments per pass by default.

import type { MonitorBrowser } from "./browser.js";
import { commentCount } from "./counts.js";
import type { ItemSource, Match, MonitorEvent } from "./events.js";
import {
  NOTIFICATIONS_URL,
  accountKey,
  accountLabel,
  activityUrl,
  parseCommentUrn,
  parsePostUrn,
  postUrl,
  searchUrl,
  sharesUrl,
  timeFromId,
  type AccountRef,
  type PostRef,
} from "./ids.js";
import {
  bareContext,
  commentItem,
  commentKey,
  isOwn,
  mentionsAccount,
  normalizePosts,
  notificationKey,
  postContext,
  postItem,
  readNotification,
  type Account,
  type Addressed,
  type LinkedInItem,
  type LinkedInPost,
  type ParentContext,
  type PostContext,
} from "./items.js";
import { TERMS_PER_QUERY, keywordMatcher, searchQueries, searchTerms, signature, type Matcher } from "./keywords.js";
import { errorText, makeLogger, type LogSink, type Logger } from "./log.js";
import { defaultSleep, loadPage, waitForElement, type Sleep } from "./page.js";
import {
  HOME_READY_SELECTOR,
  NOTIFICATIONS_READY_SELECTOR,
  POSTS_READY_SELECTOR,
  SIGN_IN_URL,
  THREAD_READY_SELECTOR,
  identityScript,
  notificationsScript,
  postsScript,
  scrollScript,
  threadScript,
  type Gate,
  type IdentitySnapshot,
  type NotificationsSnapshot,
  type PageDiag,
  type PageHealth,
  type PostsSnapshot,
  type RawComment,
  type RawNotification,
  type RawPost,
  type ScrollState,
  type ThreadSnapshot,
} from "./scripts.js";
import {
  MAX_PASS_NOTES,
  MAX_POSTS_WATCHED,
  MAX_SEEN,
  normalizeState,
  type MonitorState,
  type PostWatch,
  type SourceState,
} from "./state.js";
import { drawnTimeRange, type TimeRange } from "./times.js";
import { byUrgency, triage } from "./triage.js";

export { defaultSleep, type Sleep } from "./page.js";

const BLANK_PAGE = "about:blank";
const NOTIFICATIONS = "notifications";
/** How many already-seen items a read must pass before it is sure it is back
 *  in ground the last pass covered. */
const KNOWN_TO_STOP = 3;
/** How many scrolls in a row may bring nothing before the page is taken to
 *  have ended. */
const MAX_STALLS = 2;
/** How long a post's page may take to draw its comments. Shorter than a
 *  feed's wait: a post with no comments draws none, and that is not worth
 *  twenty seconds. */
const THREAD_WAIT_MS = 12_000;
/** The pause before every page after the first, and after every scroll. */
const PAGE_PAUSE_MS: readonly [number, number] = [6_000, 14_000];
const SCROLL_PAUSE_MS: readonly [number, number] = [1_500, 4_000];
const CONTEXT_TEXT = 200;

export interface PassDeps {
  browser: MonitorBrowser;
  state: MonitorState;
  now?: () => number;
  sleep?: Sleep;
  /** A source of numbers in [0, 1), for the pauses a person would take. */
  random?: () => number;
  log?: LogSink;
  /** Called for every event as it happens, before the pass returns. */
  onEvent?: (event: MonitorEvent) => void;
  /** Called with what the pass is doing, for a status line. */
  onStep?: (step: string) => void;
  /** Checked between pages, so Stop ends the pass instead of waiting it out. */
  shouldStop?: () => boolean;
}

export interface PassSummary {
  signedIn: boolean;
  /** The signed-in member's public id, or their name when the page did not
   *  link their profile. */
  handle?: string;
  /** The profile is not signed in to LinkedIn, so nothing could be read. */
  loginRequired: boolean;
  /** LinkedIn stopped the session at a security check. Someone has to open
   *  linkedin.com in the profile and complete it. */
  securityCheck: boolean;
  /** LinkedIn is restricting the account (a weekly limit, "unusual
   *  activity", HTTP 999), and the pass stopped. */
  rateLimited: boolean;
  /** Why the pass stopped reading, when it did. The next pass should back
   *  off. */
  blocked?: string;
  /** LinkedIn's search limit for free accounts was reached: the searches
   *  were skipped, the other sources read as usual. */
  searchLimited: boolean;
  /** Pages opened on linkedin.com. */
  pagesLoaded: number;
  /** Sources read: the notifications, each watched account, each search. */
  sourcesRead: number;
  /** Sources read for the first time, or with a new term set: what they hold
   *  is the starting line, and nothing in them is announced. */
  baselines: number;
  /** Accounts read from the posts tab because the activity page drew
   *  nothing. */
  fallbacks: number;
  /** Sources that could not be read this pass: not found, or nothing drawn. */
  unreadable: number;
  /** Searches run. */
  searches: number;
  /** Posts and notification cards read across the sources. */
  itemsRead: number;
  scrolls: number;
  /** Items that matched, new or not, inside the age window. */
  matches: number;
  newItems: number;
  /** New items triaged as high urgency. */
  urgent: number;
  /** Posts opened to read their comments, and posts whose comments are due
   *  but wait for the next pass because this one had opened its share. */
  commentReads: number;
  commentReadsDeferred: number;
  stopped: boolean;
  notes: string[];
}

export interface PassResult {
  state: MonitorState;
  events: MonitorEvent[];
  summary: PassSummary;
  /** Every item the pass found that matched, new or not, inside the age
   *  window, most urgent first: what a dashboard shows. */
  matches: Match[];
}

export interface AccountCheck {
  signedIn: boolean;
  /** The public id when the page linked it, the name otherwise. */
  handle?: string;
  name?: string;
  slug?: string;
  /** LinkedIn wants a security check before anything else. */
  securityCheck?: boolean;
  /** Why linkedin.com could not be read at all. */
  blocked?: string;
}

class StopRequested extends Error {}
class SignedOut extends Error {}
class SecurityCheck extends Error {}
class RateLimited extends Error {}
class Blocked extends Error {}
class SearchLimited extends Error {}

const SECURITY_NOTE = "LinkedIn stopped this account at a security check. Open linkedin.com in the profile and complete it; monitoring picks up on the next pass.";
const SIGNED_OUT_NOTE = "The profile is not signed in to LinkedIn. Everything the monitor reads needs a signed-in member: sign it in, and monitoring picks up on the next pass.";
const NO_SOURCES_NOTE = "Nothing to watch: turn on notifications, add up to 10 accounts, or add your company's name and keywords to search for.";
const NO_TERMS_NOTE = "No company names or keywords: nothing is searched, and only notifications and the watched accounts' posts are reported. Add your company's name and a few keywords.";
const NO_IDENTITY_NOTE = "Signed in, but LinkedIn did not say as whom: mentions of the account and its own posts are not recognized this pass.";

function restrictedNote(text: string): string {
  return `LinkedIn is restricting this account ("${text}"). The pass stopped; the next one waits three intervals.`;
}

function searchLimitNote(text: string): string {
  return `LinkedIn's search limit is reached ("${text}"): searches are skipped this pass; notifications, accounts and comments are read as usual.`;
}

function networkNote(text: string): string {
  return `linkedin.com could not be reached (${text}). The pass stopped; the next one waits three intervals.`;
}

/** checkAccount opens linkedin.com and reads who is signed in, and stops
 *  there: nothing else is read, and the page is left open for a person who is
 *  about to sign in. It is what a panel calls before any monitoring has run. */
export async function checkAccount(deps: { browser: MonitorBrowser; now?: () => number; sleep?: Sleep; log?: LogSink }): Promise<AccountCheck> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const log = makeLogger(deps.log, now);
  await deps.browser.open(SIGN_IN_URL);
  await deps.browser.waitForLoad(20).catch(() => undefined);
  await waitForElement(deps.browser, HOME_READY_SELECTOR, 15_000, sleep, now);
  const me = await deps.browser.evaluate<IdentitySnapshot>(identityScript(), "identity");
  log("identity", { url: me.url, gate: me.gate, name: me.name, slug: me.slug, chrome: me.chrome });
  if (me.gate.network_error) return { signedIn: false, blocked: networkNote(me.gate.network_error) };
  if (me.gate.checkpoint) return { signedIn: false, securityCheck: true };
  if (me.gate.login_wall || (!me.chrome && !me.name)) return { signedIn: false };
  const handle = me.slug || me.name;
  const who = { ...(handle ? { handle } : {}), ...(me.name ? { name: me.name } : {}), ...(me.slug ? { slug: me.slug } : {}) };
  if (me.gate.restricted) return { signedIn: true, ...who, blocked: restrictedNote(me.gate.restricted) };
  return { signedIn: true, ...who };
}

/** runPass runs one monitoring pass. It does not throw for anything LinkedIn
 *  or the browser does; failures end up in the summary's notes and the log. */
export async function runPass(deps: PassDeps): Promise<PassResult> {
  return new Pass(deps).run();
}

/** A post whose comments are worth reading this pass. */
interface ThreadPlan {
  ref: PostRef;
  context: PostContext;
  /** The drawn comment count, when the post was read from a page. */
  count?: number;
  /** The account wrote it: every comment on it is addressed to the account. */
  own: boolean;
  /** 0: the account's own post; 1: a post about the account; 2: a watched
   *  account's post. Lower is read first. */
  priority: number;
  /** The post itself is new this pass: every comment on it is too. */
  fresh: boolean;
  /** The starting line of the source that surfaced it. */
  since: number;
  /** What its comments are reported as coming from. */
  source: ItemSource;
  sourceKey: string;
  /** Comments it gained since the last look. */
  gained: number;
}

interface PostsRead {
  posts: LinkedInPost[];
  name: string;
  empty: boolean;
  readAt: number;
}

class Pass {
  private readonly browser: MonitorBrowser;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly deps: PassDeps;
  private readonly at: number;
  private state: MonitorState;
  private readonly events: MonitorEvent[] = [];
  private readonly matches = new Map<string, Match>();
  /** What was seen before this pass: the feed position rule needs the line
   *  as it was, not as this pass moves it. */
  private readonly seenBefore: ReadonlySet<string>;
  private readonly seen: Set<string>;
  private readonly seenOrder: string[];
  private readonly sources: Record<string, SourceState> = {};
  private readonly posts: Record<string, PostWatch>;
  private readonly plans = new Map<string, ThreadPlan>();
  /** Notification matches wait for the comment reads, which draw the post
   *  they are about, so the alert can carry it. */
  private readonly pending: Match[] = [];
  /** Every post read this pass, by id, for that context. */
  private readonly postsRead = new Map<string, LinkedInPost>();
  private readonly planned = new Set<string>();
  private readonly keywords: Matcher;
  private readonly companies: Matcher;
  private readonly excluded: Matcher;
  private readonly urgent: Matcher;
  private account: Account = {};
  private memberRead = false;
  private opened = false;
  private readonly summary: PassSummary = {
    signedIn: false,
    loginRequired: false,
    securityCheck: false,
    rateLimited: false,
    searchLimited: false,
    pagesLoaded: 0,
    sourcesRead: 0,
    baselines: 0,
    fallbacks: 0,
    unreadable: 0,
    searches: 0,
    itemsRead: 0,
    scrolls: 0,
    matches: 0,
    newItems: 0,
    urgent: 0,
    commentReads: 0,
    commentReadsDeferred: 0,
    stopped: false,
    notes: [],
  };

  constructor(deps: PassDeps) {
    this.deps = deps;
    this.browser = deps.browser;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.log = makeLogger(deps.log, this.now);
    this.at = this.now();
    this.state = normalizeState(deps.state);
    this.seenOrder = [...this.state.seen];
    this.seenBefore = new Set(this.seenOrder);
    this.seen = new Set(this.seenOrder);
    this.posts = { ...this.state.posts };
    const settings = this.state.settings;
    this.keywords = keywordMatcher(settings.keywords);
    this.companies = keywordMatcher(settings.companyNames);
    this.excluded = keywordMatcher(settings.excludeKeywords);
    this.urgent = keywordMatcher(settings.urgentTerms);
  }

  async run(): Promise<PassResult> {
    this.log("pass_start", { settings: this.state.settings, account: this.state.account?.handle });
    const settings = this.state.settings;
    const terms = searchTerms(settings.companyNames, settings.keywords);
    const searching = settings.searchKeywords && settings.maxSearches > 0 && terms.length > 0;
    try {
      if (!settings.watchNotifications && settings.accounts.length === 0 && !searching) {
        this.note(NO_SOURCES_NOTE);
      } else {
        if (terms.length === 0) this.note(NO_TERMS_NOTE);
        if (settings.watchNotifications) await this.readNotifications();
        for (const account of settings.accounts) await this.readAccountPosts(account);
        if (searching) await this.readSearches(terms);
        await this.readThreads();
      }
    } catch (error) {
      if (error instanceof StopRequested) {
        this.summary.stopped = true;
      } else if (error instanceof SignedOut) {
        this.signOut();
      } else if (error instanceof SecurityCheck) {
        this.securityCheck();
      } else if (error instanceof RateLimited) {
        this.summary.rateLimited = true;
        this.summary.blocked = error.message;
        this.note(error.message);
      } else if (error instanceof Blocked) {
        this.summary.blocked = error.message;
        this.note(error.message);
      } else {
        this.note(`The pass failed: ${errorText(error)}`);
        this.log("pass_error", { error: errorText(error) });
      }
    } finally {
      // What the notifications found is announced even when a later page
      // stopped the pass: it was read, and it is in the state as seen.
      this.flushPending();
      await this.park();
    }
    this.finish();
    const matches = [...this.matches.values()].sort(byUrgency);
    this.summary.matches = matches.length;
    this.log("pass_end", { ...this.summary });
    return { state: this.state, events: this.events, summary: this.summary, matches };
  }

  // --- the member --------------------------------------------------------------

  /** readMember reads who is signed in, once per pass, on the first page that
   *  is past the sign-in wall. The public id tells the account's own posts
   *  and its tags; the name tells a mention written as plain text. */
  private async readMember(): Promise<void> {
    if (this.memberRead) return;
    this.memberRead = true;
    const me = await this.browser.evaluate<IdentitySnapshot>(identityScript(), "identity");
    this.log("identity", { url: me.url, gate: me.gate, name: me.name, slug: me.slug, chrome: me.chrome });
    this.checkGate(me.gate);
    const previous = this.state.account;
    const same = !previous || sameMember(previous, me);
    const slug = me.slug || (same ? previous?.slug : undefined);
    const name = me.name || (same ? previous?.name : undefined);
    const handle = slug || name;
    if (!handle) this.note(NO_IDENTITY_NOTE);
    if (!previous?.signedIn) this.emit({ type: "signed_in", at: this.at, ...(handle ? { handle } : {}), ...(name ? { name } : {}) });
    if (previous?.handle && handle && !same) {
      this.emit({ type: "account_changed", at: this.at, previous: previous.name || previous.handle, current: name || handle });
      // Another member's notifications and own posts are not this one's: the
      // notifications start a new starting line.
      for (const [id, watch] of Object.entries(this.posts)) {
        if (watch.own || watch.source === NOTIFICATIONS) delete this.posts[id];
      }
      const { [NOTIFICATIONS]: _dropped, ...sources } = this.state.sources;
      this.state = { ...this.state, sources };
    }
    this.account = { ...(name ? { name } : {}), ...(slug ? { slug } : {}) };
    this.state = {
      ...this.state,
      account: { ...(handle ? { handle } : {}), ...(name ? { name } : {}), ...(slug ? { slug } : {}), signedIn: true, checkedAt: this.at },
    };
    this.summary.signedIn = true;
    if (handle) this.summary.handle = handle;
  }

  private signOut(): void {
    const previous = this.state.account;
    if (previous?.signedIn !== false) this.emit({ type: "signed_out", at: this.at, ...(previous?.handle ? { handle: previous.handle } : {}) });
    this.state = {
      ...this.state,
      account: {
        ...(previous?.handle ? { handle: previous.handle } : {}),
        ...(previous?.name ? { name: previous.name } : {}),
        ...(previous?.slug ? { slug: previous.slug } : {}),
        signedIn: false,
        checkedAt: this.at,
      },
    };
    this.summary.signedIn = false;
    this.summary.loginRequired = true;
    this.note(SIGNED_OUT_NOTE);
  }

  private securityCheck(): void {
    const handle = this.summary.handle || this.state.account?.handle;
    this.emit({ type: "security_check", at: this.at, ...(handle ? { handle } : {}) });
    this.summary.securityCheck = true;
    this.summary.blocked = SECURITY_NOTE;
    this.note(SECURITY_NOTE);
  }

  // --- notifications -----------------------------------------------------------

  /** readNotifications reads the account's notifications, newest first: who
   *  mentioned it, who commented on its posts, who replied to its comments.
   *  Every new card that points at a post also makes that post's comments
   *  due, so an aggregated card ("… and 3 others commented") still gets each
   *  comment read. */
  private async readNotifications(): Promise<void> {
    const key = NOTIFICATIONS;
    this.planned.add(key);
    this.step("Reading your notifications");
    const page = await this.load(NOTIFICATIONS_URL, NOTIFICATIONS_READY_SELECTOR);
    await this.readMember();
    const previous = this.state.sources[key];
    const baseline = !previous;
    const since = previous?.since ?? this.at;
    const read = page.rendered
      ? await this.collect<NotificationsSnapshot, RawNotification>(notificationsScript(), "notifications", (snapshot) => snapshot.cards, notificationKey, baseline, since, () => undefined)
      : { items: [], empty: page.empty, readAt: this.now(), diag: page.diag };
    if (read.items.length === 0 && !read.empty && !page.empty) {
      this.log("source_empty", { source: key, diag: read.diag ?? page.diag });
      this.sourceFailed(key, "LinkedIn drew no notifications this pass; they are read again on the next one.");
      return;
    }
    const readAt = read.readAt;
    const source: ItemSource = { kind: "notifications", name: "notifications" };
    const fresh: Match[] = [];
    this.summary.sourcesRead += 1;
    this.summary.itemsRead += read.items.length;
    for (const card of read.items) {
      const cardKey = notificationKey(card);
      const range = drawnTimeRange(card.time_text, readAt);
      const newCard = !baseline && !this.seenBefore.has(cardKey) && (!range || range.latest >= since);
      this.remember(cardKey);
      const reading = readNotification(card, this.account, readAt);
      if (reading.skip || !reading.post) continue;
      if (newCard && this.state.settings.watchComments) {
        this.addPlan({
          ref: reading.post,
          context: bareContext(reading.post, reading.ownPost ? this.account.name ?? "" : ""),
          own: reading.ownPost,
          priority: reading.ownPost ? 0 : 1,
          fresh: false,
          since,
          source: { kind: "comments", name: "notifications" },
          sourceKey: key,
          gained: 0,
        }, true);
      }
      if (!reading.item || isOwn(reading.item, this.account)) continue;
      let item = reading.item;
      if (!item.addressed && mentionsAccount(item.text, [], this.account)) item = { ...item, addressed: "mention" };
      const company = this.companies(item.text)[0];
      if (company) item = { ...item, company };
      const keywords = this.keywords(item.text);
      const seenBefore = this.seen.has(item.key);
      this.remember(item.key);
      // A card LinkedIn could not say much about — another language, a verb
      // this monitor does not know — counts only when it names something.
      if (!item.addressed && !company && keywords.length === 0) continue;
      if (!item.addressed && this.excluded(item.text).length > 0) continue;
      const match: Match = { item, source, keywords, triage: triage(item, { keywords, urgent: this.urgent }) };
      const idTime = timeFromId(item.id);
      if (this.inWindow(idTime ?? range?.latest) && !this.matches.has(item.key)) this.matches.set(item.key, match);
      const isNew = !baseline && !seenBefore && freshItem(idTime, range, since, readAt, this.state.settings.maxItemAgeMs, newCard);
      if (isNew) fresh.push(match);
    }
    this.pending.push(...fresh);
    if (baseline) this.summary.baselines += 1;
    this.log("source", { source: key, baseline, read: read.items.length, fresh: fresh.length });
    this.sources[key] = {
      since,
      filter: "",
      lastReadAt: this.at,
      ...(fresh.length > 0 ? { lastNewAt: this.at } : previous?.lastNewAt !== undefined ? { lastNewAt: previous.lastNewAt } : {}),
    };
  }

  // --- watched accounts ------------------------------------------------------------

  /** readAccountPosts reads one watched person's or company's newest posts.
   *  A person's activity page is lazy and sometimes draws nothing at all; it
   *  is retried once from their posts tab before the account is noted as
   *  unreadable for this pass. */
  private async readAccountPosts(account: AccountRef): Promise<void> {
    const key = accountKey(account);
    this.planned.add(key);
    const previous = this.state.sources[key];
    const label = previous?.name ?? accountLabel(account);
    this.step(`Reading ${label}`);
    const baseline = !previous;
    const since = previous?.since ?? this.at;
    let page = await this.load(activityUrl(account), POSTS_READY_SELECTOR);
    await this.readMember();
    if (page.gate.unavailable) {
      this.sourceFailed(key, `${label} was not found, or is not visible to this account: check the link.`);
      return;
    }
    let read = await this.readPosts(page, baseline, since);
    let fallback = false;
    if (read.posts.length === 0 && !read.empty && account.kind === "person") {
      page = await this.load(sharesUrl(account), POSTS_READY_SELECTOR);
      if (page.gate.unavailable) {
        this.sourceFailed(key, `${label} was not found, or is not visible to this account: check the link.`);
        return;
      }
      read = await this.readPosts(page, baseline, since);
      if (read.posts.length > 0) {
        fallback = true;
        this.summary.fallbacks += 1;
        this.note(`${read.name || label} was read from the posts tab: the activity page drew nothing.`);
      }
    }
    const name = previous?.name ?? (read.posts.length > 0 ? nameFrom(read, account) : undefined);
    if (read.posts.length === 0 && !read.empty) {
      this.sourceFailed(key, `LinkedIn drew no posts for ${name ?? label} this pass; it is tried again on the next one.`);
      return;
    }
    this.considerPosts({
      key,
      source: { kind: "account", name: name ?? label, account },
      filter: "all",
      filtered: false,
      read,
      fallback,
      ...(name ? { name } : {}),
    });
  }

  // --- search ----------------------------------------------------------------------

  /** readSearches searches LinkedIn's posts for the company names and the
   *  keywords, newest first, in at most maxSearches queries. Search is the
   *  first thing LinkedIn limits on a free account; when it does, the rest of
   *  the searches are skipped and the pass goes on. */
  private async readSearches(terms: string[]): Promise<void> {
    const settings = this.state.settings;
    const queries = searchQueries(terms, settings.maxSearches);
    const unsearched = terms.length - Math.min(terms.length, settings.maxSearches * TERMS_PER_QUERY);
    if (unsearched > 0) {
      this.note(`${unsearched} term${unsearched === 1 ? " is" : "s are"} not searched (at most ${TERMS_PER_QUERY} per search); they are still matched in everything else read.`);
    }
    const filter = signature(terms);
    for (const query of queries) {
      const key = searchKey(query);
      this.planned.add(key);
      this.step(`Searching LinkedIn for ${query}`);
      const previous = this.state.sources[key];
      const baseline = !previous || previous.filter !== filter;
      const since = baseline ? this.at : previous.since;
      try {
        const page = await this.load(searchUrl(query), POSTS_READY_SELECTOR, undefined, true);
        await this.readMember();
        const read = await this.readPosts(page, baseline, since, true);
        if (read.posts.length === 0 && !read.empty) {
          this.sourceFailed(key, `LinkedIn drew no results for ${query} this pass; it is searched again on the next one.`);
          continue;
        }
        this.summary.searches += 1;
        this.considerPosts({ key, source: { kind: "search", name: query, query }, filter, filtered: true, read, fallback: false });
      } catch (error) {
        if (!(error instanceof SearchLimited)) throw error;
        this.summary.searchLimited = true;
        this.note(searchLimitNote(error.message));
        this.log("search_limited", { query, notice: error.message });
        return;
      }
    }
  }

  // --- posts -----------------------------------------------------------------------

  /** readPosts reads the posts a page drew, scrolling until the read is back
   *  in ground the last pass covered. */
  private async readPosts(page: PageHealth, baseline: boolean, since: number, search = false): Promise<PostsRead> {
    if (!page.rendered) return { posts: [], name: "", empty: page.empty, readAt: this.now() };
    let name = "";
    const read = await this.collect<PostsSnapshot, RawPost>(
      postsScript(),
      "posts",
      (snapshot) => {
        name = name || snapshot.name;
        return snapshot.posts;
      },
      (raw) => {
        const ref = parsePostUrn(raw.urn);
        return ref ? `post:${ref.id}` : "";
      },
      baseline,
      since,
      (raw) => timeFromId(parsePostUrn(raw.urn)?.id),
      search,
    );
    if (read.items.length === 0 && read.diag) this.log("posts_empty_read", { url: page.url, diag: read.diag });
    return { posts: normalizePosts(read.items, read.readAt), name, empty: read.empty || page.empty, readAt: read.readAt };
  }

  /** considerPosts decides what in one source's posts is new, ranks what
   *  matches, records the source, and plans the comment reads that are due.
   *
   *  A post is new when its id was not seen before and its id says it was
   *  created after the source's starting line. A post whose id carries no
   *  time (none has been seen yet, but LinkedIn's ids are LinkedIn's) falls
   *  back to the Facebook monitor's rules: above the newest known post, or a
   *  drawn time after the starting line. */
  private considerPosts(input: {
    key: string;
    source: ItemSource;
    filter: string;
    /** Only posts that mention the account or name a company name or a
     *  keyword count (a search); otherwise every post does (an account). */
    filtered: boolean;
    read: PostsRead;
    fallback: boolean;
    name?: string;
  }): void {
    const { key, source, read } = input;
    const posts = read.posts;
    const previous = this.state.sources[key];
    const baseline = !previous || previous.filter !== input.filter;
    const since = baseline ? this.at : previous.since;
    const line = posts.findIndex((post) => this.seenBefore.has(post.key));
    const maxAge = this.state.settings.maxItemAgeMs;
    const fresh: Match[] = [];
    this.summary.sourcesRead += 1;
    this.summary.itemsRead += posts.length;

    const last = posts.at(-1);
    const lastTime = last ? timeFromId(last.ref.id) : undefined;
    if (!baseline && posts.length > 0 && line < 0 && (lastTime === undefined || lastTime >= since)) {
      this.note(`${source.name}: the read did not get back to posts seen before (${posts.length} read); posts in between may be missed.`);
    }

    for (const [index, post] of posts.entries()) {
      this.postsRead.set(post.ref.id, post);
      const own = isOwn(post, this.account);
      const mention = !own && mentionsAccount(post.text, post.mentions, this.account);
      const company = own ? undefined : this.companies([post.text, ...post.mentions.map((tag) => tag.name)].join("\n"))[0];
      const keywords = this.keywords(post.text);
      const idTime = timeFromId(post.ref.id);
      // Unseen means unseen by any source, this pass included: a post a
      // notification already reported is not reported again by a search.
      const isNew = !baseline && !this.seen.has(post.key)
        && freshItem(idTime, post.range, since, read.readAt, maxAge, line >= 0 && index < line);
      const watch = this.posts[post.ref.id];
      const gained = watch?.comments !== undefined && post.comments !== undefined ? Math.max(0, post.comments - watch.comments) : 0;
      this.planPost(post, {
        own,
        aboutYou: own || mention || !!company || keywords.length > 0,
        watched: source.kind === "account",
        isNew,
        baseline,
        since,
        source,
        sourceKey: key,
      });
      this.remember(post.key);
      if (own) continue;
      if (input.filtered && !mention && !company && keywords.length === 0) continue;
      if (!mention && this.excluded(post.text).length > 0) continue;
      const item = postItem(post, mention ? "mention" : undefined, company);
      const match: Match = { item, source, keywords, triage: triage(item, { keywords, urgent: this.urgent, gained }) };
      if (this.inWindow(idTime ?? post.range?.latest) && !this.matches.has(item.key)) this.matches.set(item.key, match);
      if (isNew) fresh.push(match);
    }

    fresh.sort((left, right) => (left.item.createdAt ?? 0) - (right.item.createdAt ?? 0));
    for (const match of fresh) this.announce(match);
    if (baseline) this.summary.baselines += 1;
    this.log("source", { source: key, baseline, read: posts.length, line, fresh: fresh.length, fallback: input.fallback });
    this.sources[key] = {
      since,
      filter: input.filter,
      ...(input.name ? { name: input.name } : previous?.name ? { name: previous.name } : {}),
      lastReadAt: this.at,
      ...(fresh.length > 0 ? { lastNewAt: this.at } : previous?.lastNewAt !== undefined && !baseline ? { lastNewAt: previous.lastNewAt } : {}),
      ...(input.fallback ? { fallback: true } : {}),
    };
  }

  // --- comments ----------------------------------------------------------------

  /** planPost decides whether a post's comments are due. Only posts that
   *  concern the account are watched — its own posts, and posts that mention
   *  it or name your company or a keyword — and the watched accounts' posts.
   *  A post seen for the first time is only recorded — its comments are part
   *  of the starting line — unless the post itself is new: then its comments
   *  are all new too. After that, a post is opened only when its drawn comment
   *  count grew, or when a read of it is still owed. */
  private planPost(
    post: LinkedInPost,
    about: { own: boolean; aboutYou: boolean; watched: boolean; isNew: boolean; baseline: boolean; since: number; source: ItemSource; sourceKey: string },
  ): void {
    if (!this.state.settings.watchComments || post.comments === undefined) return;
    if (!about.aboutYou && !about.watched) return;
    const watch = this.posts[post.ref.id];
    const count = post.comments;
    const grew = watch?.comments !== undefined ? count > watch.comments : !watch && !about.baseline && about.isNew && count > 0;
    const own = about.own || !!watch?.own;
    if (!grew && !watch?.due) {
      this.posts[post.ref.id] = {
        urn: post.ref.urn,
        source: watch?.source ?? about.sourceKey,
        own,
        comments: watch?.comments !== undefined ? Math.min(watch.comments, count) : count,
        ...(watch?.threadReadAt !== undefined ? { threadReadAt: watch.threadReadAt } : {}),
        checkedAt: this.at,
      };
      return;
    }
    this.addPlan({
      ref: post.ref,
      context: postContext(post),
      count,
      own,
      priority: own ? 0 : about.aboutYou ? 1 : 2,
      fresh: !watch && about.isNew,
      since: about.since,
      source: { kind: "comments", name: about.source.name, ...(about.source.account ? { account: about.source.account } : {}), ...(about.source.query ? { query: about.source.query } : {}) },
      sourceKey: watch?.source ?? about.sourceKey,
      gained: count - (watch?.comments ?? 0),
    });
  }

  /** addPlan records a post whose comments are due, merging with a plan the
   *  pass already has for it: a post found twice keeps the higher priority
   *  and the better context. */
  private addPlan(plan: ThreadPlan, due = false): void {
    const id = plan.ref.id;
    const known = this.plans.get(id);
    if (!known) {
      this.plans.set(id, plan);
    } else {
      this.plans.set(id, {
        ...known,
        context: known.context.text ? known.context : plan.context,
        ...(known.count === undefined && plan.count !== undefined ? { count: plan.count } : {}),
        own: known.own || plan.own,
        priority: Math.min(known.priority, plan.priority),
        fresh: known.fresh || plan.fresh,
        since: Math.min(known.since, plan.since),
        gained: Math.max(known.gained, plan.gained),
      });
    }
    if (due) {
      const watch = this.posts[id];
      this.posts[id] = {
        urn: plan.ref.urn,
        source: watch?.source ?? plan.sourceKey,
        own: plan.own || !!watch?.own,
        ...(watch?.comments !== undefined ? { comments: watch.comments } : {}),
        due: true,
        ...(watch?.threadReadAt !== undefined ? { threadReadAt: watch.threadReadAt } : {}),
        checkedAt: this.at,
      };
    }
  }

  /** readThreads opens the posts whose comments are due, the account's own
   *  posts first, up to the pass's share. A post past that is marked due, so
   *  the next pass opens it: nothing is skipped, only delayed. */
  private async readThreads(): Promise<void> {
    if (!this.state.settings.watchComments) return;
    // Reads a pass before this one owed and could not make.
    for (const [id, watch] of Object.entries(this.posts)) {
      if (!watch.due || this.plans.has(id)) continue;
      const ref = parsePostUrn(watch.urn);
      if (!ref || !this.sourceConfigured(watch.source)) continue;
      const name = watch.source === NOTIFICATIONS ? "notifications" : this.state.sources[watch.source]?.name ?? watch.source.replace(/^(?:account|search):/, "");
      this.plans.set(id, {
        ref,
        context: bareContext(ref, watch.own ? this.account.name ?? "" : ""),
        own: watch.own,
        priority: watch.own ? 0 : 1,
        fresh: false,
        since: this.state.sources[watch.source]?.since ?? this.sources[watch.source]?.since ?? this.at,
        source: { kind: "comments", name },
        sourceKey: watch.source,
        gained: 0,
      });
    }
    const plans = [...this.plans.values()].sort((left, right) => left.priority - right.priority || right.gained - left.gained);
    for (const plan of plans) {
      const id = plan.ref.id;
      const watch = this.posts[id];
      if (this.summary.commentReads >= this.state.settings.maxCommentReads) {
        this.summary.commentReadsDeferred += 1;
        this.posts[id] = {
          urn: plan.ref.urn,
          source: watch?.source ?? plan.sourceKey,
          own: plan.own || !!watch?.own,
          ...(watch?.comments !== undefined ? { comments: watch.comments } : {}),
          due: true,
          ...(watch?.threadReadAt !== undefined ? { threadReadAt: watch.threadReadAt } : {}),
          checkedAt: this.at,
        };
        continue;
      }
      await this.readThread(plan, watch);
    }
  }

  /** readThread opens one post and reads its comments and replies. A comment
   *  is reported when it mentions the account, replies to the account's
   *  comment, is on the account's own post, or names your company or a
   *  keyword. */
  private async readThread(plan: ThreadPlan, watch: PostWatch | undefined): Promise<void> {
    const id = plan.ref.id;
    this.step(`Reading comments on ${plan.context.author ? `${plan.context.author}'s post` : "a post"}`);
    const page = await this.load(postUrl(plan.ref.urn), THREAD_READY_SELECTOR, THREAD_WAIT_MS);
    this.summary.commentReads += 1;
    if (page.gate.unavailable) {
      // The post was deleted, or its author limited who sees it.
      this.log("thread_unavailable", { post: plan.ref.urn });
      delete this.posts[id];
      return;
    }
    let thread: ThreadSnapshot;
    try {
      thread = await this.browser.evaluate<ThreadSnapshot>(threadScript(), "thread");
    } catch (error) {
      this.log("thread_failed", { post: plan.ref.urn, error: errorText(error) });
      this.note("The comments on a post could not be read; they are read again on the next pass.");
      this.posts[id] = { ...(watch ?? { urn: plan.ref.urn, source: plan.sourceKey, own: plan.own }), due: true, checkedAt: this.at };
      return;
    }
    this.checkGate(thread.gate);
    const readAt = this.now();
    const drawnPost = thread.post ? normalizePosts([thread.post], readAt).find((post) => post.ref.id === id) : undefined;
    if (drawnPost) this.postsRead.set(id, drawnPost);
    const context = drawnPost ? postContext(drawnPost) : plan.context;
    const own = plan.own || (drawnPost ? isOwn(drawnPost, this.account) : false);
    const comments = thread.comments ?? [];
    const keyOf = (raw: RawComment) => commentKey(raw, id);
    const ownKeys = new Set(comments.filter((raw) => isOwn({ author: raw.author, authorUrl: raw.author_url }, this.account)).map(keyOf));
    const byUrn = new Map(comments.filter((raw) => raw.urn).map((raw) => [parseCommentUrn(raw.urn)?.id ?? raw.urn, raw]));
    const count = Math.max(commentCount(thread.comments_text) ?? 0, plan.count ?? 0);
    const unseen = comments.filter((raw) => !this.seen.has(keyOf(raw))).length;
    const allNew = plan.fresh || (watch?.comments !== undefined && unseen <= count - watch.comments);
    const maxAge = this.state.settings.maxItemAgeMs;
    for (const raw of comments) {
      const key = keyOf(raw);
      const mine = ownKeys.has(key);
      const parentId = parseCommentUrn(raw.parent_urn)?.id;
      const parentRaw = parentId ? byUrn.get(parentId) : undefined;
      const mention = !mine && mentionsAccount(raw.text, raw.mentions ?? [], this.account);
      const replyToYou = !mine && !!parentRaw && ownKeys.has(keyOf(parentRaw));
      const addressed: Addressed | undefined = mine ? undefined : mention ? "mention" : replyToYou ? "reply" : own ? "comment_on_post" : undefined;
      const company = mine ? undefined : this.companies(raw.text)[0];
      const parent: ParentContext | undefined = parentRaw
        ? { id: parentId!, author: parentRaw.author, ...(parentRaw.text ? { text: parentRaw.text.replace(/\s+/g, " ").slice(0, CONTEXT_TEXT) } : {}) }
        : undefined;
      const item = commentItem(raw, context, readAt, { ...(addressed ? { addressed } : {}), ...(company ? { company } : {}), ...(parent ? { parent } : {}) });
      if (!item) continue;
      const idTime = timeFromId(parseCommentUrn(raw.urn)?.id);
      const range = drawnTimeRange(raw.time_text, readAt);
      const isNew = !this.seen.has(item.key) && freshComment(idTime, range, plan.since, readAt, maxAge, allNew);
      this.remember(item.key);
      if (mine) continue;
      const keywords = this.keywords(item.text);
      if (this.enrichPending(item)) continue;
      if (!addressed && !company && keywords.length === 0) continue;
      if (!addressed && this.excluded(item.text).length > 0) continue;
      const match: Match = { item, source: plan.source, keywords, triage: triage(item, { keywords, urgent: this.urgent }) };
      if (this.inWindow(idTime ?? range?.latest) && !this.matches.has(item.key)) this.matches.set(item.key, match);
      if (isNew) this.announce(match);
    }
    this.posts[id] = {
      urn: plan.ref.urn,
      source: watch?.source ?? plan.sourceKey,
      own,
      comments: Math.max(count, comments.length),
      threadReadAt: this.at,
      checkedAt: this.at,
    };
    this.log("thread", { post: plan.ref.urn, comments: comments.length, count });
  }

  /** enrichPending gives a notification match waiting to be announced what
   *  the post's page drew for the same comment: its author's headline, its
   *  full text, the comment it answers. It says whether there was one. */
  private enrichPending(item: LinkedInItem): boolean {
    const index = this.pending.findIndex((match) => match.item.key === item.key);
    if (index < 0) return false;
    const known = this.pending[index]!;
    const merged: LinkedInItem = { ...known.item, ...item, addressed: known.item.addressed ?? item.addressed };
    if (!merged.addressed) delete merged.addressed;
    this.pending[index] = this.rematch(known, merged);
    return true;
  }

  /** flushPending announces what the notifications found, with the post each
   *  item is about when a page this pass drew it. */
  private flushPending(): void {
    const ready = this.pending.splice(0).map((match) => {
      const post = this.postsRead.get(match.item.post.id);
      if (!post) return match;
      const context = postContext(post);
      if (match.item.kind === "comment") return this.rematch(match, { ...match.item, post: context });
      // A card about a post says only "mentioned you in a post": the post's
      // page said the rest.
      return this.rematch(match, {
        ...match.item,
        author: post.author || match.item.author,
        ...(post.authorHeadline ? { authorHeadline: post.authorHeadline } : {}),
        ...(post.authorUrl ? { authorUrl: post.authorUrl } : {}),
        text: post.text || match.item.text,
        ...(post.truncated ? { truncated: true } : {}),
        post: context,
        ...(post.comments !== undefined ? { replies: post.comments } : {}),
        ...(post.reactions !== undefined ? { reactions: post.reactions } : {}),
      });
    });
    ready.sort((left, right) => (left.item.createdAt ?? 0) - (right.item.createdAt ?? 0));
    for (const match of ready) this.announce(match);
  }

  /** rematch re-ranks a match whose item learned more, and keeps the
   *  dashboard's copy in step. */
  private rematch(match: Match, item: LinkedInItem): Match {
    const company = item.company ?? this.companies(item.text)[0];
    const next: LinkedInItem = company ? { ...item, company } : item;
    const keywords = this.keywords(next.text);
    const updated: Match = { ...match, item: next, keywords, triage: triage(next, { keywords, urgent: this.urgent }) };
    if (this.matches.has(next.key)) this.matches.set(next.key, updated);
    return updated;
  }

  private announce(match: Match): void {
    const account = this.account.name || this.account.slug;
    this.emit({ type: "new_item", at: this.at, ...(account ? { account } : {}), ...match });
    this.summary.newItems += 1;
    if (match.triage.urgency === "high") this.summary.urgent += 1;
  }

  private inWindow(time: number | undefined): boolean {
    const maxAge = this.state.settings.maxItemAgeMs;
    return maxAge === 0 || time === undefined || time >= this.at - maxAge;
  }

  private sourceFailed(key: string, note: string): void {
    this.summary.unreadable += 1;
    this.note(note);
    this.log("source_failed", { source: key, note });
    const previous = this.state.sources[key];
    if (previous) this.sources[key] = { ...previous, note };
  }

  private remember(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
  }

  // --- plumbing --------------------------------------------------------------

  /** collect reads a page top down, scrolling until the read is back in
   *  ground the last pass covered (three known items, or an item older than
   *  the starting line at the bottom), the scroll limit is reached, or the
   *  page ends. A first read takes what is drawn and does not scroll: it
   *  announces nothing, so there is nothing to look for further down. */
  private async collect<S extends { gate: Gate; empty: boolean; diag?: PageDiag }, R>(
    script: string,
    label: string,
    extract: (snapshot: S) => R[],
    keyOf: (raw: R) => string,
    baseline: boolean,
    since: number,
    timeOf: (raw: R) => number | undefined,
    search = false,
  ): Promise<{ items: R[]; empty: boolean; readAt: number; diag?: PageDiag }> {
    const items: R[] = [];
    const keys = new Set<string>();
    let readAt = this.now();
    let empty = false;
    let diag: PageDiag | undefined;
    let scrolls = 0;
    let stalls = 0;
    for (;;) {
      const snapshot = await this.browser.evaluate<S>(script, label);
      this.checkGate(snapshot.gate, search);
      readAt = this.now();
      empty = snapshot.empty;
      diag = snapshot.diag;
      const before = items.length;
      for (const raw of extract(snapshot) ?? []) {
        const key = keyOf(raw);
        if (!key || keys.has(key)) continue;
        keys.add(key);
        items.push(raw);
      }
      if (baseline || items.length === 0) break;
      if (items.filter((raw) => this.seenBefore.has(keyOf(raw))).length >= KNOWN_TO_STOP) break;
      const bottom = timeOf(items[items.length - 1]!);
      if (bottom !== undefined && bottom < since) break;
      if (scrolls >= this.state.settings.maxScrolls) break;
      this.checkStop();
      // A reader scrolls by a little more or less each time.
      const scroll = await this.browser.evaluate<ScrollState>(scrollScript(0.6 + 0.3 * this.random()), "scroll");
      scrolls += 1;
      this.summary.scrolls += 1;
      await this.sleep(this.pause(SCROLL_PAUSE_MS));
      if (items.length === before && scroll.after <= scroll.before) {
        stalls += 1;
        if (stalls >= MAX_STALLS) break;
      } else {
        stalls = 0;
      }
    }
    return { items, empty, readAt, ...(diag ? { diag } : {}) };
  }

  /** load opens one page, paced like a person moving between pages, and turns
   *  the screens that end a pass — the sign-in wall, a security check, a
   *  restriction, no network — into the matching error. */
  private async load(url: string, readySelector: string, readyMs?: number, search = false): Promise<PageHealth> {
    this.checkStop();
    if (this.summary.pagesLoaded > 0) await this.sleep(this.pause(PAGE_PAUSE_MS));
    this.checkStop();
    this.opened = true;
    let page: PageHealth;
    try {
      page = await loadPage(this.browser, url, readySelector, {
        sleep: this.sleep,
        log: this.log,
        now: this.now,
        ...(readyMs !== undefined ? { readyMs } : {}),
      });
    } catch (error) {
      if (error instanceof StopRequested) throw error;
      throw new Blocked(`The profile's browser could not open linkedin.com (${errorText(error)}). The pass stopped; the next one waits three intervals.`);
    }
    this.summary.pagesLoaded += 1;
    this.checkGate(page.gate, search);
    return page;
  }

  private checkGate(gate: Gate | undefined, search = false): void {
    if (!gate) return;
    if (gate.network_error) throw new Blocked(networkNote(gate.network_error));
    if (gate.checkpoint) throw new SecurityCheck();
    if (gate.login_wall) throw new SignedOut();
    if (gate.restricted) throw new RateLimited(restrictedNote(gate.restricted));
    if (search && gate.search_limit) throw new SearchLimited(gate.search_limit);
  }

  /** sourceConfigured tells a source the settings still ask for. */
  private sourceConfigured(key: string): boolean {
    const settings = this.state.settings;
    if (key === NOTIFICATIONS) return settings.watchNotifications;
    if (key.startsWith("account:")) return settings.accounts.some((account) => accountKey(account) === key);
    if (key.startsWith("search:")) {
      if (!settings.searchKeywords) return false;
      const terms = searchTerms(settings.companyNames, settings.keywords);
      return searchQueries(terms, settings.maxSearches).some((query) => searchKey(query) === key);
    }
    return false;
  }

  /** finish settles the sources, the watched posts and the seen list. A
   *  source that is no longer configured is forgotten, with the posts found
   *  in it, so adding it back starts a fresh starting line. */
  private finish(): void {
    const deferred = this.summary.commentReadsDeferred;
    if (deferred > 0) this.note(`${deferred} post${deferred === 1 ? "" : "s"} with new comments wait${deferred === 1 ? "s" : ""} for the next pass (maxCommentReads).`);
    const sources: Record<string, SourceState> = {};
    for (const [key, value] of Object.entries(this.state.sources)) {
      if (this.sourceConfigured(key)) sources[key] = value;
    }
    Object.assign(sources, this.sources);
    const posts = Object.fromEntries(
      Object.entries(this.posts)
        .filter(([, watch]) => this.sourceConfigured(watch.source))
        .sort(([, left], [, right]) => left.checkedAt - right.checkedAt)
        .slice(-MAX_POSTS_WATCHED),
    );
    this.state = {
      ...this.state,
      sources,
      posts,
      seen: this.seenOrder.slice(-MAX_SEEN),
      lastPass: {
        at: this.at,
        finishedAt: this.now(),
        newItems: this.summary.newItems,
        urgent: this.summary.urgent,
        notes: this.summary.notes,
      },
    };
  }

  /** park leaves the tab on a blank page, so nothing is left polling
   *  linkedin.com between passes. It is best effort. */
  private async park(): Promise<void> {
    if (!this.state.settings.parkTab || !this.opened) return;
    try {
      await this.browser.open(BLANK_PAGE);
    } catch (error) {
      this.log("park_failed", { error: errorText(error) });
    }
  }

  private pause([min, max]: readonly [number, number]): number {
    return Math.round(min + (max - min) * this.random());
  }

  private emit(event: MonitorEvent): void {
    this.events.push(event);
    this.log("event", { event });
    try {
      this.deps.onEvent?.(event);
    } catch (error) {
      this.log("on_event_failed", { error: errorText(error) });
    }
  }

  private step(step: string): void {
    this.log("step", { step });
    try {
      this.deps.onStep?.(step);
    } catch {
      /* a status line is not worth a pass */
    }
  }

  private note(note: string): void {
    if (this.summary.notes.includes(note)) return;
    this.summary.notes = [...this.summary.notes, note].slice(-MAX_PASS_NOTES);
  }

  private checkStop(): void {
    if (this.deps.shouldStop?.()) throw new StopRequested("stopped");
  }
}

/** searchKey is how a search is keyed in the state. */
function searchKey(query: string): string {
  return `search:${query.toLowerCase()}`;
}

/** nameFrom is what an account is called: the name the page drew, or the
 *  author of its own posts. */
function nameFrom(read: PostsRead, account: AccountRef): string | undefined {
  const authored = read.posts.find((post) => post.authorSlug?.toLowerCase() === account.slug.toLowerCase() && !post.resharedBy);
  return authored?.author || read.name || undefined;
}

/** sameMember tells whether the member a page shows is the one on record:
 *  by public id when both are known, by name otherwise. */
function sameMember(previous: { name?: string; slug?: string }, me: IdentitySnapshot): boolean {
  if (previous.slug && me.slug) return previous.slug.toLowerCase() === me.slug.toLowerCase();
  if (previous.name && me.name) return previous.name.trim().toLowerCase() === me.name.trim().toLowerCase();
  return true;
}

/** freshItem decides whether an unseen post or notification is new. Its id's
 *  time decides when it has one: created after the starting line and inside
 *  the age window. Without one, a drawn time that puts it before the starting
 *  line or past the window rules it out; then its position does (above a
 *  known post, or a new card), or a drawn time entirely after the line. */
export function freshItem(idTime: number | undefined, range: TimeRange | undefined, since: number, readAt: number, maxAge: number, positional: boolean): boolean {
  const tooOld = (time: number) => maxAge > 0 && time < readAt - maxAge;
  if (idTime !== undefined) return idTime >= since && !tooOld(idTime);
  if (range && (range.latest < since || tooOld(range.latest))) return false;
  if (positional) return true;
  return !!range && range.earliest >= since;
}

/** freshComment decides whether an unseen comment is new: by its id's time,
 *  or its drawn time, after the starting line; without either, only when
 *  every unseen comment must be new — under a post that is itself new, or
 *  when no more comments are unseen than the count grew by. */
export function freshComment(idTime: number | undefined, range: TimeRange | undefined, since: number, readAt: number, maxAge: number, allNew: boolean): boolean {
  const tooOld = (time: number) => maxAge > 0 && time < readAt - maxAge;
  if (idTime !== undefined) return idTime >= since && !tooOld(idTime);
  if (range) return range.latest >= since && !tooOld(range.latest);
  return allNew;
}
