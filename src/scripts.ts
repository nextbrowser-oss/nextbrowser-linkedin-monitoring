// Page scripts: every read the monitor makes on linkedin.com.
//
// LinkedIn draws its pages from data its own app fetches with per-session
// tokens (the "Voyager" API), and that data is neither something a script
// outside the app can ask for and keep up with, nor something LinkedIn's
// public API offers a member's own tools. What a signed-in member sees,
// though, is drawn into the page. So the monitor reads the page: it opens the
// notifications, an account's posts, a search or a post, waits until they are
// drawn, and reads them out of the DOM.
//
// What survives LinkedIn's releases is leaned on first:
//
//   - URNs LinkedIn writes into its own markup: data-urn="urn:li:activity:<id>"
//     on every post in a feed, a search result or a post's own page,
//     data-chameleon-result-urn on search results, data-id="urn:li:comment:…"
//     on every comment;
//   - link shapes: a post (/feed/update/<urn>/, /posts/<slug>-activity-<id>-),
//     a comment (?commentUrn=, &replyUrn=), a person (/in/<slug>/), a company
//     (/company/<slug>/);
//   - aria labels and roles: buttons labelled "23 comments", "1,234
//     reactions", "Comment", "…more"; dialogs and headings for LinkedIn's own
//     notices;
//   - dir="ltr" on user-written text.
//
// Where a class name is the only hook there is, it is used, always with a
// fallback, and named here so the next person knows what to check first when
// a read comes back empty: feed-shared-update-v2 and update-components-actor
// (a post and its author), update-components-text (a post's text),
// update-components-header (the "… reposted this" line), nt-card (a
// notification), comments-comment-entity / comments-comment-item (a comment),
// global-nav__me-photo (the signed-in member's photo), and visually-hidden
// (the screen-reader copy of a name, skipped so it is not read twice).
//
// Words are leaned on only where nothing else exists: the sign-in wall, the
// security check, a restriction, the search limit, "not available", and the
// verbs of a notification ("mentioned you", "commented on your post"). They
// are matched in English; an account whose LinkedIn is set to another
// language reads posts and comments all the same, but those states and
// notifications are told apart less precisely.
//
// Each script is one expression returning a JSON-serializable value, run
// through CDP Runtime.evaluate with returnByValue. Nothing here clicks, types
// or submits: a post cut short by "…more" is reported as cut short rather than
// expanded.

/** jsLiteral renders a value as a JavaScript literal safe to inline. */
export function jsLiteral(value: unknown): string {
  return JSON.stringify(value ?? "");
}

/** Where a person signs in, and where checkAccount looks: a signed-out
 *  profile is sent from the feed to the sign-in page. */
export const SIGN_IN_URL = "https://www.linkedin.com/feed/";

/** A post, wherever LinkedIn draws one. */
export const POST_SELECTOR = [
  '[data-urn^="urn:li:activity:"]',
  '[data-urn^="urn:li:share:"]',
  '[data-urn^="urn:li:ugcPost:"]',
  '[data-chameleon-result-urn^="urn:li:activity:"]',
  '[data-chameleon-result-urn^="urn:li:share:"]',
  '[data-chameleon-result-urn^="urn:li:ugcPost:"]',
].join(", ");
/** A notification card. */
export const NOTIFICATION_SELECTOR = 'article.nt-card, [data-urn*="fs_notification"], [data-urn*="urn:li:notification"]';
/** A comment or a reply. */
export const COMMENT_SELECTOR = '[data-id^="urn:li:comment"], article.comments-comment-entity, article.comments-comment-item';
/** Anything a page is opened for. */
const CONTENT_SELECTOR = `${POST_SELECTOR}, ${NOTIFICATION_SELECTOR}, ${COMMENT_SELECTOR}`;
/** What is inside a post but not the post's own: its comments, a post it
 *  reshares, another post. */
const NESTED_SELECTOR = `${COMMENT_SELECTOR}, ${POST_SELECTOR}, .update-components-mini-update-v2, .feed-shared-mini-update-v2, .update-components-reshare`;

/** What an account's posts page and a search draw once LinkedIn has answered:
 *  a post. */
export const POSTS_READY_SELECTOR = POST_SELECTOR;
export const NOTIFICATIONS_READY_SELECTOR = NOTIFICATION_SELECTOR;
/** What a post's own page draws once its comments are in. */
export const THREAD_READY_SELECTOR = COMMENT_SELECTOR;
/** What any signed-in page draws: the member's own photo in the global nav. */
export const HOME_READY_SELECTOR = `img.global-nav__me-photo, .global-nav__me, ${POST_SELECTOR}`;

/** How much of a post or a comment is kept. */
export const TEXT_MAX = 2_000;

/** gate() names every screen LinkedIn puts between a session and a page:
 *
 *  - the sign-in wall: /authwall, /login, /uas/login, /signup, the sign-in
 *    pages under /checkpoint/lg/, a sign-in form, or a page drawn for a
 *    visitor (sign-in links and no member photo in the nav);
 *  - a security check: anything else under /checkpoint/, or "Let's do a quick
 *    security check";
 *  - a restriction: "You've reached the weekly limit", "temporarily
 *    restricted", "unusual activity", or HTTP 999, the status LinkedIn answers
 *    automated traffic with;
 *  - the search limit: "commercial use limit", LinkedIn's cap on searches by
 *    free accounts — it closes search, not the rest of LinkedIn;
 *  - not available: a profile, a company or a post that is not there, or not
 *    there for this account;
 *  - no network: Chromium's own error page, with its ERR_ code.
 *
 *  What LinkedIn says about the session it says in a dialog, a banner or a
 *  heading. Posts can say anything ("we saw unusual activity on our
 *  servers"), so the rest of the page is only searched when no post was
 *  drawn. */
const GATE_HELPER = String.raw`
  const has = (selector) => { try { return !!document.querySelector(selector); } catch (error) { return false; } };
  const textIn = (selector) => { try { return Array.from(document.querySelectorAll(selector)).map((node) => String(node.innerText || node.textContent || "")).join(" ").replace(/\s+/g, " "); } catch (error) { return ""; } };
  const pageText = () => String((document.body && (document.body.innerText || document.body.textContent)) || "").replace(/\s+/g, " ");
  const CONTENT = ${jsLiteral(CONTENT_SELECTOR)};
  const httpStatus = () => {
    try {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry && typeof entry.responseStatus === "number" ? entry.responseStatus : 0;
    } catch (error) { return 0; }
  };
  const signedInChrome = () => has('img.global-nav__me-photo, .global-nav__me, [data-test-global-nav-me]');
  const gate = () => {
    const path = String(location.pathname || "").toLowerCase();
    const errorPage = String(location.protocol || "") === "chrome-error:" || String(location.href || "").indexOf("chrome-error://") === 0;
    const content = has(CONTENT);
    const text = pageText();
    const notice = textIn('[role="dialog"], [role="alertdialog"], [role="alert"], h1, h2, h3') + " " + (content ? "" : text);
    const status = httpStatus();
    const loginPath = /^\/(?:authwall|login|uas\/login|signup|checkpoint\/lg\/|checkpoint\/rm\/sign-in)/.test(path);
    const checkpoint = !loginPath && (path.indexOf("/checkpoint/") === 0 || /let[’']s do a quick security check/i.test(notice));
    const loginForm = has('input[name="session_key"]') || has('form[action*="login-submit"]') || has('form[action*="/uas/login"]');
    const visitor = !signedInChrome() && has('a[href*="/login"], a[href*="/uas/login"], a[href*="/signup"]');
    const restricted = /you[’']ve reached the weekly (?:invitation )?limit|temporarily restricted|unusual activity (?:from|on) your account|your account (?:has been|is) (?:temporarily )?restricted|we[’']ve restricted your account/i.exec(notice);
    const limit = /(?:reached|hit) the commercial use limit|commercial use limit on search|monthly limit for (?:profile )?searches/i.exec(notice);
    const unavailable = !content && !errorPage && (/^\/404\/?$/.test(path) || /this page doesn[’']t exist|page not found|(?:this )?profile (?:is )?not available|this profile is unavailable|this (?:content|post|page) (?:isn[’']t|is no longer|is not) available|this post cannot be displayed|this post (?:was|has been) (?:deleted|removed)/i.test(text));
    const network = errorPage ? ((/\b(ERR_[A-Z_]+)\b/.exec(text) || [])[1] || "the page could not be loaded") : "";
    return {
      login_wall: !checkpoint && !errorPage && (loginPath || loginForm || visitor),
      checkpoint: checkpoint,
      restricted: restricted ? restricted[0].slice(0, 120) : status === 999 ? "HTTP 999" : "",
      search_limit: limit ? limit[0].slice(0, 120) : "",
      unavailable: unavailable,
      network_error: network
    };
  };
  const gated = (state) => state.login_wall || state.checkpoint || !!state.restricted || !!state.search_limit || state.unavailable || !!state.network_error;
  const EMPTY = /no results found|hasn[’']t posted|has not posted|no recent (?:activity|posts)|hasn[’']t (?:shared|posted) (?:anything|lately)|nothing to see for now|no new notifications|you[’']re all caught up|no posts yet/i;
  const emptyNotice = () => !has(CONTENT) && EMPTY.test(textIn('main, [role="main"]') || pageText());`;

/** pageDiag() describes the page for the log. Every field is read
 *  defensively: a diagnostic must never be what breaks the read it describes. */
const DIAG_HELPER = String.raw`
  const pageDiag = () => {
    const count = (selector) => { try { return document.querySelectorAll(selector).length; } catch (error) { return 0; } };
    const view = typeof window === "object" && window ? window : {};
    return {
      width: Number(view.innerWidth) || 0,
      height: Number(view.innerHeight) || 0,
      ready: String(document.readyState || ""),
      title: String(document.title || "").slice(0, 80),
      posts: count(${jsLiteral(POST_SELECTOR)}),
      cards: count(${jsLiteral(NOTIFICATION_SELECTOR)}),
      comments: count(${jsLiteral(COMMENT_SELECTOR)}),
      status: httpStatus(),
      text: pageText().trim().slice(0, 160)
    };
  };`;

/** Links, names, times and text: how a post, a comment and a notification
 *  are read the way a person sees them. */
const READ_HELPER = String.raw`
  const NESTED = ${jsLiteral(NESTED_SELECTOR)};
  const HIDDEN = ".visually-hidden, .a11y-text";
  const is = (node, selector) => { try { return !!(node && node.matches && node.matches(selector)); } catch (error) { return false; } };
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const absolute = (href) => { try { return new URL(String(href || ""), location.href); } catch (error) { return null; } };
  const onLinkedIn = (url) => !!url && /(^|\.)linkedin\.com$/i.test(url.hostname);
  const profileOf = (href) => {
    const url = absolute(href);
    if (!onLinkedIn(url)) return null;
    const match = /^\/(in|company)\/([^/?#]+)/i.exec(url.pathname);
    if (!match) return null;
    let slug = match[2];
    try { slug = decodeURIComponent(slug); } catch (error) {}
    const segment = match[1].toLowerCase();
    return { kind: segment === "in" ? "person" : "company", slug: slug, url: "https://www.linkedin.com/" + segment + "/" + match[2] + "/" };
  };
  const URN_KIND = (kind) => kind.toLowerCase() === "ugcpost" ? "ugcPost" : kind.toLowerCase();
  const postUrnOf = (value) => {
    const text = String(value || "");
    const urn = /urn(?::|%3A)li(?::|%3A)(activity|share|ugcPost)(?::|%3A)(\d{6,25})/i.exec(text);
    if (urn) return "urn:li:" + URN_KIND(urn[1]) + ":" + urn[2];
    const slug = /\/posts\/[^?#]*-(activity|share|ugcPost)-(\d{6,25})-/i.exec(text);
    return slug ? "urn:li:" + URN_KIND(slug[1]) + ":" + slug[2] : "";
  };
  // own() keeps what belongs to root itself: nothing inside a comment, a
  // reshared post or another post nested in it.
  const own = (root, selector) => Array.from(root.querySelectorAll(selector)).filter((node) => {
    if (is(node, NESTED)) return false;
    for (let current = node.parentElement; current && current !== root; current = current.parentElement) {
      if (is(current, NESTED)) return false;
    }
    return true;
  });
  const outermost = (nodes) => nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
  // textOf reads user-written text the way a reader sees it: the words, the
  // line breaks, and the emoji drawn as images, which innerText leaves out.
  // Buttons ("…more", menus) and the screen-reader copies of names are not the
  // author's words and are skipped.
  const textOf = (root) => {
    let out = "";
    const walk = (node) => {
      if (node.nodeType === 3) {
        // Whitespace that only lays out the markup is not the author's.
        if (!/\S/.test(node.data) && /\n/.test(node.data)) { if (out && !/\s$/.test(out)) out += " "; return; }
        out += node.data;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === "IMG") { out += node.getAttribute("alt") && node.getAttribute("alt").length <= 4 ? node.getAttribute("alt") : ""; return; }
      if (tag === "BR") { out += "\n"; return; }
      if (tag === "BUTTON" || tag === "SCRIPT" || tag === "STYLE" || node.getAttribute("role") === "button" || is(node, HIDDEN)) return;
      let block = tag === "DIV" || tag === "P";
      try { const display = getComputedStyle(node).display; if (display) block = display === "block"; } catch (error) {}
      if (block && out && !/\n[ \t]*$/.test(out)) out += "\n";
      for (const child of node.childNodes) walk(child);
      if (block && !/\n[ \t]*$/.test(out)) out += "\n";
    };
    if (root) walk(root);
    return out.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\s*…\s*$/, "").trim().slice(0, ${TEXT_MAX});
  };
  const labelOf = (node) => clean(node && ((node.getAttribute && node.getAttribute("aria-label")) || textOf(node) || node.textContent));
  // nameOf reads a name: the visible text, once — LinkedIn draws a name for
  // the eye and again for a screen reader — or an image's alt text.
  const nameOf = (node) => {
    if (!node) return "";
    let name = clean(textOf(node));
    if (name.length % 2 === 1) {
      const half = name.slice(0, (name.length - 1) / 2);
      if (half && name === half + " " + half) name = half;
    }
    if (!name && node.querySelector) {
      const image = node.querySelector("img[alt]");
      name = clean(image ? image.getAttribute("alt") : "");
    }
    const view = /^view:?\s+(.+?)(?:[’']s?\s+(?:profile|page))?$/i.exec(name);
    if (view) name = view[1];
    return name.replace(/\s*[•·]\s*(?:1st|2nd|3rd\+?|you|following|premium)\b.*$/i, "").slice(0, 100);
  };
  const TIME_LABEL = /^(?:now|just now|\d{1,3}\s?(?:s|m|h|d|w|mo|yr|y)|\d{1,3}\s+(?:second|minute|hour|day|week|month|year)s?(?:\s+ago)?)(?![\p{L}\p{N}])/iu;
  const timeLabel = (value) => clean(String(value || "").split(/[•·]/)[0]);
  const timeIn = (root, nodes) => {
    for (const node of nodes) {
      const value = timeLabel(textOf(node) || node.getAttribute("aria-label"));
      if (value && value.length <= 40 && TIME_LABEL.test(value)) return value;
    }
    return "";
  };
  const mentionsIn = (root, author) => {
    const out = [];
    if (!root) return out;
    for (const link of Array.from(root.querySelectorAll("a[href]"))) {
      const profile = profileOf(link.getAttribute("href"));
      const name = nameOf(link);
      if (!profile || !name || (author && profile.url === author)) continue;
      if (!out.some((known) => known.url === profile.url)) out.push({ name: name, kind: profile.kind, slug: profile.slug, url: profile.url });
    }
    return out.slice(0, 10);
  };
  const COMMENTS_LABEL = /^\d[\d\s.,'KkMm]*\s*comments?\b/i;
  const REPOSTS_LABEL = /^\d[\d\s.,'KkMm]*\s*reposts?\b/i;
  const REACTIONS_LABEL = /^\d[\d\s.,'KkMm]*\s*reactions?\b/i;
  const AND_OTHERS = /\band \d[\d\s.,'KkMm]*\s*others?$/i;
  const SEE_MORE = /^(?:…|\.\.\.)?\s*(?:see\s+)?more\b/i;
  const ACTOR = ".update-components-actor, .feed-shared-actor";
  const ACTOR_NAME = ".update-components-actor__title, .update-components-actor__name, .feed-shared-actor__name";
  const ACTOR_HEADLINE = ".update-components-actor__description, .feed-shared-actor__description";
  const ACTOR_TIME = ".update-components-actor__sub-description, .feed-shared-actor__sub-description";
  const POST_TEXT = ".update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text, .feed-shared-text";
  // readPost reads one post: its URN, its author, its text and its counts,
  // from the post's own markup only.
  const readPost = (outer) => {
    let unit = outer;
    let urn = postUrnOf(unit.getAttribute("data-urn")) || postUrnOf(unit.getAttribute("data-chameleon-result-urn"));
    // A search result's container names the post again on the post's own
    // element inside it; that element is the post.
    const inner = urn ? Array.from(outer.querySelectorAll("[data-urn]")).find((node) => postUrnOf(node.getAttribute("data-urn")) === urn) : null;
    if (inner) unit = inner;
    if (!urn) {
      for (const link of own(unit, "a[href]")) { urn = postUrnOf(link.getAttribute("href")); if (urn) break; }
    }
    if (!urn) return null;
    const area = own(unit, ACTOR)[0] || unit;
    const named = area.querySelector(ACTOR_NAME);
    let author = null;
    for (const link of (area === unit ? own(unit, "a[href]") : Array.from(area.querySelectorAll("a[href]")))) {
      const profile = profileOf(link.getAttribute("href"));
      if (!profile) continue;
      const name = nameOf(named) || nameOf(link);
      if (name) { author = { name: name, profile: profile }; break; }
    }
    const headlineNode = area.querySelector(ACTOR_HEADLINE);
    const timeNode = area.querySelector(ACTOR_TIME);
    const timeText = (timeNode && timeIn(unit, [timeNode])) || timeIn(unit, own(unit, "time, span"));
    const header = own(unit, ".update-components-header, .feed-shared-header")[0] || null;
    const headerText = header ? clean(textOf(header)) : "";
    let resharedBy = "";
    if (/\b(?:reposted|reshared)\b/i.test(headerText)) {
      const link = Array.from(header.querySelectorAll("a[href]")).find((node) => profileOf(node.getAttribute("href")));
      resharedBy = link ? nameOf(link) : headerText.replace(/\s+(?:reposted|reshared)\b.*$/i, "");
    }
    const reshare = !!resharedBy || !!unit.querySelector(".update-components-mini-update-v2, .feed-shared-mini-update-v2, .update-components-reshare");
    const textRoot = own(unit, POST_TEXT)[0] || null;
    let text = textRoot ? textOf(textRoot) : "";
    if (!text) {
      // No marked text: the longest piece of user-written text in the post
      // that is not its author's name, headline or time.
      for (const node of own(unit, 'span[dir="ltr"], div[dir="ltr"]')) {
        if (area !== unit && area.contains(node)) continue;
        if (header && header.contains(node)) continue;
        const value = textOf(node);
        if (value.length > text.length && (!author || value !== author.name)) text = value;
      }
    }
    const buttons = own(unit, 'button, [role="button"]');
    const labels = own(unit, "button, span, a, li").map((node) => labelOf(node)).filter((label) => label && label.length <= 80);
    const reactionNode = own(unit, ".social-details-social-counts__reactions-count")[0];
    let reactionsText = reactionNode ? clean(textOf(reactionNode) || reactionNode.textContent) : "";
    if (!reactionsText) reactionsText = labels.find((label) => REACTIONS_LABEL.test(label)) || labels.find((label) => AND_OTHERS.test(label)) || "";
    return {
      urn: urn,
      author: author ? author.name : "",
      author_kind: author ? author.profile.kind : "",
      author_slug: author ? author.profile.slug : "",
      author_url: author ? author.profile.url : "",
      author_headline: headlineNode ? clean(textOf(headlineNode)).slice(0, 200) : "",
      text: text,
      truncated: buttons.some((node) => SEE_MORE.test(labelOf(node))),
      time_text: timeText,
      mentions: mentionsIn(textRoot, author ? author.profile.url : ""),
      comments_text: labels.find((label) => COMMENTS_LABEL.test(label)) || "",
      reactions_text: reactionsText,
      reposts_text: labels.find((label) => REPOSTS_LABEL.test(label)) || "",
      action_bar: buttons.some((node) => /^comment$/i.test(labelOf(node))),
      reshare: reshare,
      reshared_by: resharedBy
    };
  };`;

/** What any read reports about the screens between the session and the
 *  page. */
export interface Gate {
  login_wall: boolean;
  checkpoint: boolean;
  /** The restriction notice as LinkedIn worded it, or "HTTP 999". */
  restricted: string;
  /** LinkedIn's search limit for free accounts, as worded. */
  search_limit: string;
  /** The profile, company or post is not there for this account. */
  unavailable: boolean;
  /** The browser could not load the page: Chromium's ERR_ code. */
  network_error: string;
}

/** What pageDiag() reports. */
export interface PageDiag {
  width: number;
  height: number;
  ready: string;
  title: string;
  posts: number;
  cards: number;
  comments: number;
  status: number;
  text: string;
}

/** What a page did after load. */
export interface PageHealth {
  url: string;
  /** LinkedIn drew posts, notifications or comments. */
  rendered: boolean;
  /** How many of them. */
  units: number;
  /** LinkedIn said there is nothing here: no results, no recent posts, no
   *  notifications. An answer, not a failure. */
  empty: boolean;
  gate: Gate;
  diag?: PageDiag;
}

/** pageHealthScript says what the page shows: what it was opened for, or one
 *  of the screens in front of it. */
export function pageHealthScript(): string {
  return String.raw`(() => {${GATE_HELPER}${DIAG_HELPER}
  const count = (selector) => { try { return document.querySelectorAll(selector).length; } catch (error) { return 0; } };
  const units = count(CONTENT);
  const state = gate();
  const out = { url: location.href, rendered: units > 0, units: units, empty: emptyNotice(), gate: state };
  if (!out.rendered || gated(state)) out.diag = pageDiag();
  return out;
})()`;
}

/** existsScript asks whether anything in the document matches a selector, or
 *  whether the page is one of the screens in front of it, or says it is empty,
 *  which ends a wait just as well: there is nothing more to draw there. */
export function existsScript(selector: string): string {
  return String.raw`(() => {${GATE_HELPER}
  try { return { found: gated(gate()) || emptyNotice() || !!document.querySelector(${jsLiteral(selector)}) }; } catch (error) { return { found: false }; }
})()`;
}

/** Who is signed in. */
export interface IdentitySnapshot {
  url: string;
  gate: Gate;
  /** The member's name: the alt text of their photo in the global nav. */
  name: string;
  /** Their public id (/in/<slug>/), when the page links their own profile —
   *  the feed's identity card does. */
  slug: string;
  /** Whether the signed-in chrome (the member's photo, "Me") is drawn. */
  chrome: boolean;
}

/** identityScript reads who is signed in. LinkedIn's session cookie (li_at)
 *  is HttpOnly, so a script cannot see it; what it can see is the global nav
 *  a member gets, whose "Me" photo carries their name, and on the feed the
 *  identity card that links their profile. Posts by other people carry names
 *  and photos too, so only those two places are trusted. */
export function identityScript(): string {
  return String.raw`(() => {${GATE_HELPER}${READ_HELPER}
  const photo = document.querySelector("img.global-nav__me-photo, .global-nav__me img[alt], [data-test-global-nav-me] img[alt]");
  let name = clean(photo ? photo.getAttribute("alt") : "").replace(/^(?:photo of|profile photo of)\s+/i, "");
  if (/^(?:me|you|profile photo|photo)$/i.test(name) || name.length > 100) name = "";
  let slug = "";
  const card = document.querySelector('.feed-identity-module a[href*="/in/"], .global-nav__me a[href*="/in/"], [data-view-name="identity-module"] a[href*="/in/"], a.profile-card-profile-link[href*="/in/"]');
  const profile = card ? profileOf(card.getAttribute("href")) : null;
  if (profile && profile.kind === "person") slug = profile.slug;
  if (!name && card) name = nameOf(card);
  return { url: location.href, gate: gate(), name: name, slug: slug, chrome: signedInChrome() };
})()`;
}

export interface RawMention {
  name: string;
  kind: "person" | "company";
  slug: string;
  url: string;
}

/** A post as the page drew it. */
export interface RawPost {
  /** "urn:li:activity:<id>" (or share, ugcPost). */
  urn: string;
  author: string;
  /** "person", "company", or "" when the page linked no author. */
  author_kind: string;
  author_slug: string;
  /** The author's profile or company page, without tracking parameters. */
  author_url: string;
  /** "Head of Operations at Foo", or a company's follower line. */
  author_headline: string;
  text: string;
  /** LinkedIn cut the text short behind "…more". */
  truncated: boolean;
  /** The drawn time: "3h", "1w". */
  time_text: string;
  /** People and companies tagged in the text. */
  mentions: RawMention[];
  /** "23 comments", or "" when none is drawn. */
  comments_text: string;
  /** "1,234", "Mila Novak and 12 others", or "". */
  reactions_text: string;
  reposts_text: string;
  /** Whether the post's action bar (Like · Comment · Repost · Send) is
   *  drawn. With it drawn and no comment count beside it, the post has no
   *  comments. */
  action_bar: boolean;
  /** A repost, with or without the reposter's own words. */
  reshare: boolean;
  /** For a plain repost: who reposted it ("Mila Novak reposted this"). */
  reshared_by: string;
}

export interface PostsSnapshot {
  url: string;
  gate: Gate;
  /** The page's name for whose posts these are, from its heading or title. */
  name: string;
  empty: boolean;
  posts: RawPost[];
  diag?: PageDiag;
}

/** postsScript reads the posts a page has drawn, top to bottom: an account's
 *  recent activity, a company's posts, or a search's results — all newest
 *  first. A post holds its comments and, for a repost, the post it shares;
 *  everything read for the post is read outside those, so a commenter is never
 *  taken for the author. */
export function postsScript(): string {
  return String.raw`(() => {${GATE_HELPER}${DIAG_HELPER}${READ_HELPER}
  const title = String(document.title || "").replace(/^\(\d+\+?\)\s*/, "").replace(/\s*\|\s*LinkedIn\s*$/i, "").replace(/^(?:activity|posts)\s*\|\s*/i, "").replace(/:\s*posts$/i, "").trim();
  const heading = document.querySelector("main h1, h1");
  const name = clean(heading ? textOf(heading) : "") || title;
  const out = { url: location.href, gate: gate(), name: name.slice(0, 120), empty: emptyNotice(), posts: [] };
  const units = outermost(Array.from(document.querySelectorAll(${jsLiteral(POST_SELECTOR)})).filter((node) => !node.closest(${jsLiteral(COMMENT_SELECTOR)})));
  const seen = new Set();
  for (const unit of units) {
    const post = readPost(unit);
    if (!post || seen.has(post.urn)) continue;
    seen.add(post.urn);
    out.posts.push(post);
  }
  if (out.posts.length === 0) out.diag = pageDiag();
  return out;
})()`;
}

/** A notification as the page drew it. */
export interface RawNotification {
  /** What the card says: "Mila Novak mentioned you in a comment." */
  headline: string;
  /** The quoted words under or inside it, when drawn. */
  snippet: string;
  actor: string;
  actor_kind: string;
  actor_url: string;
  /** The post it links, or "": a birthday or a job alert links none. */
  post_urn: string;
  /** The comment it links (?commentUrn=), or "". */
  comment_urn: string;
  /** The reply it links (&replyUrn=), or "". */
  reply_urn: string;
  time_text: string;
  /** The card's link, absolute. */
  link: string;
}

export interface NotificationsSnapshot {
  url: string;
  gate: Gate;
  empty: boolean;
  cards: RawNotification[];
  diag?: PageDiag;
}

/** notificationsScript reads the notification cards, newest first. A card's
 *  link says what it is about — a post, a comment (?commentUrn=), a reply
 *  (&replyUrn=) — whatever language its words are in. */
export function notificationsScript(): string {
  return String.raw`(() => {${GATE_HELPER}${DIAG_HELPER}${READ_HELPER}
  const out = { url: location.href, gate: gate(), empty: emptyNotice(), cards: [] };
  let cards = outermost(Array.from(document.querySelectorAll(${jsLiteral(NOTIFICATION_SELECTOR)})));
  if (cards.length === 0) cards = outermost(Array.from(document.querySelectorAll('main article, [role="main"] article')));
  for (const card of cards) {
    let postUrn = "";
    let commentUrn = "";
    let replyUrn = "";
    let link = "";
    for (const anchor of Array.from(card.querySelectorAll("a[href]"))) {
      const url = absolute(anchor.getAttribute("href"));
      if (!onLinkedIn(url)) continue;
      const urn = postUrnOf(url.pathname) || postUrnOf(url.search);
      if (!urn) continue;
      postUrn = urn;
      link = url.href;
      commentUrn = String(url.searchParams.get("commentUrn") || "");
      replyUrn = String(url.searchParams.get("replyUrn") || "");
      break;
    }
    let actor = null;
    for (const anchor of Array.from(card.querySelectorAll("a[href]"))) {
      const profile = profileOf(anchor.getAttribute("href"));
      // A link around the whole sentence names its person in bold.
      const name = nameOf(anchor.querySelector("strong")) || nameOf(anchor);
      if (profile && name) { actor = { name: name, profile: profile }; break; }
    }
    const headlineNode = card.querySelector(".nt-card__headline, .nt-card__text") || card;
    const headline = clean(textOf(headlineNode));
    if (!actor) {
      const strong = headlineNode.querySelector("strong");
      if (strong) actor = { name: clean(textOf(strong)), profile: null };
    }
    const quote = card.querySelector("blockquote, q, .nt-card__quote");
    let snippet = quote ? clean(textOf(quote)) : "";
    if (!snippet) {
      const quoted = /[“"«]([^”"»]{2,})[”"»]\s*\.?$/.exec(headline);
      const after = /^[^:]{3,160}?:\s+(.+)$/.exec(headline);
      snippet = quoted ? quoted[1] : after ? after[1] : "";
    }
    if (!link) {
      const anchor = card.querySelector("a[href]");
      const url = anchor ? absolute(anchor.getAttribute("href")) : null;
      link = url && onLinkedIn(url) ? url.href : "";
    }
    out.cards.push({
      headline: headline.slice(0, 600),
      snippet: snippet.slice(0, ${TEXT_MAX}),
      actor: actor ? actor.name : "",
      actor_kind: actor && actor.profile ? actor.profile.kind : "",
      actor_url: actor && actor.profile ? actor.profile.url : "",
      post_urn: postUrn,
      comment_urn: commentUrn,
      reply_urn: replyUrn,
      time_text: timeIn(card, Array.from(card.querySelectorAll("time, span, p"))),
      link: link
    });
  }
  if (out.cards.length === 0) out.diag = pageDiag();
  return out;
})()`;
}

/** A comment or a reply as the post's page drew it. */
export interface RawComment {
  /** Its data-id: "urn:li:comment:(activity:<post>,<id>)", or "". */
  urn: string;
  /** For a reply, the URN of the comment it answers; "" for a comment. */
  parent_urn: string;
  author: string;
  author_kind: string;
  author_url: string;
  author_headline: string;
  text: string;
  time_text: string;
  mentions: RawMention[];
  /** "2 replies", or "". */
  replies_text: string;
}

export interface ThreadSnapshot {
  url: string;
  gate: Gate;
  /** The post itself, as its page drew it. */
  post: RawPost | null;
  /** The post's own comment count, as drawn on its page. */
  comments_text: string;
  comments: RawComment[];
  diag?: PageDiag;
}

/** threadScript reads a post's own page: the post, and the comments and
 *  replies LinkedIn drew under it (its "Most relevant" selection, unless the
 *  person switched the post to "Most recent"). Each comment carries its
 *  data-id URN, and a reply the URN of the comment it answers. */
export function threadScript(): string {
  return String.raw`(() => {${GATE_HELPER}${DIAG_HELPER}${READ_HELPER}
  const out = { url: location.href, gate: gate(), post: null, comments_text: "", comments: [] };
  const units = outermost(Array.from(document.querySelectorAll(${jsLiteral(POST_SELECTOR)})).filter((node) => !node.closest(${jsLiteral(COMMENT_SELECTOR)})));
  if (units[0]) {
    out.post = readPost(units[0]);
    out.comments_text = out.post ? out.post.comments_text : "";
  }
  const idOf = (node) => String(node.getAttribute("data-id") || "");
  const all = Array.from(document.querySelectorAll(${jsLiteral(COMMENT_SELECTOR)}));
  // One element per comment: an article without an id inside the element
  // that carries it is the same comment.
  const comments = all.filter((node) => !all.some((other) => other !== node && other.contains(node) && (!idOf(node) || idOf(other) === idOf(node))));
  const seen = new Set();
  for (const comment of comments) {
    const urn = idOf(comment) || (comment.querySelector("[data-id]") ? idOf(comment.querySelector("[data-id]")) : "");
    let parent = null;
    for (let current = comment.parentElement; current; current = current.parentElement) {
      if (comments.indexOf(current) >= 0) { parent = current; break; }
    }
    const area = own(comment, ".comments-comment-meta__actor, .comments-post-meta, .comments-comment-item__post-meta")[0] || comment;
    const named = area.querySelector(".comments-comment-meta__description-title, .comments-post-meta__name-text");
    let author = null;
    for (const link of (area === comment ? own(comment, "a[href]") : Array.from(area.querySelectorAll("a[href]")))) {
      const profile = profileOf(link.getAttribute("href"));
      const name = nameOf(named) || nameOf(link);
      if (profile && name) { author = { name: name, profile: profile }; break; }
    }
    const headlineNode = area.querySelector(".comments-comment-meta__description-subtitle, .comments-post-meta__headline");
    const textRoot = own(comment, ".comments-comment-item__main-content, .comments-comment-entity__content, .update-components-text")[0] || null;
    let text = textRoot ? textOf(textRoot) : "";
    if (!text) {
      for (const node of own(comment, 'span[dir="ltr"], div[dir="ltr"]')) {
        if (area !== comment && area.contains(node)) continue;
        const value = textOf(node);
        if (value.length > text.length && (!author || value !== author.name)) text = value;
      }
    }
    const key = urn || ((author ? author.name : "") + "|" + text);
    if ((!text && !urn) || seen.has(key)) continue;
    seen.add(key);
    const labels = own(comment, "button, span").map((node) => labelOf(node)).filter((label) => label && label.length <= 40);
    out.comments.push({
      urn: urn,
      parent_urn: parent ? idOf(parent) : "",
      author: author ? author.name : "",
      author_kind: author ? author.profile.kind : "",
      author_url: author ? author.profile.url : "",
      author_headline: headlineNode ? clean(textOf(headlineNode)).slice(0, 200) : "",
      text: text,
      time_text: timeIn(comment, own(comment, "time, span")),
      mentions: mentionsIn(textRoot, author ? author.profile.url : ""),
      replies_text: labels.find((label) => /^\d+\s+repl(?:y|ies)\b/i.test(label)) || ""
    });
  }
  if (out.comments.length === 0) out.diag = pageDiag();
  return out;
})()`;
}

/** Where scrollScript left the page. */
export interface ScrollState {
  before: number;
  after: number;
  height: number;
}

/** scrollScript advances the page by part of a viewport — the fraction the
 *  engine picks, a little different every time, as a reader's would be —
 *  which makes LinkedIn draw the next posts, and says whether it moved. */
export function scrollScript(fraction = 0.8): string {
  const share = Math.min(1, Math.max(0.3, Number.isFinite(fraction) ? fraction : 0.8));
  return `(() => {
  const before = window.scrollY;
  const distance = Math.max(Math.floor(window.innerHeight * ${share.toFixed(2)}), 400);
  window.scrollBy(0, distance);
  return { before: before, after: window.scrollY, height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) };
})()`;
}

/** Every script with a label, for the tests that make sure each one is at
 *  least a valid expression. */
export function allScripts(): Record<string, string> {
  return {
    health: pageHealthScript(),
    exists: existsScript(POSTS_READY_SELECTOR),
    identity: identityScript(),
    posts: postsScript(),
    notifications: notificationsScript(),
    thread: threadScript(),
    scroll: scrollScript(),
  };
}
