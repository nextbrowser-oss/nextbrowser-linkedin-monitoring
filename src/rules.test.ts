// The pure rules: ids and links, drawn times and counts, items and
// notifications, keyword matching and search queries, urgency triage, and the
// state document.

import { describe, expect, it } from "vitest";
import { commentCount, parseCount, reactionCount } from "./counts.js";
import { freshComment, freshItem } from "./engine.js";
import {
  accountFromUrl,
  accountKey,
  activityUrl,
  commentUrl,
  normalizeAccount,
  parseCommentUrn,
  parsePostUrn,
  postUrl,
  searchUrl,
  sharesUrl,
  timeFromId,
} from "./ids.js";
import { commentItem, isOwn, mentionsAccount, normalizePosts, notificationKey, postItem, readNotification } from "./items.js";
import { keywordMatcher, searchQueries, searchTerms, signature } from "./keywords.js";
import { scheduleDelay } from "./schedule.js";
import { emptyState, normalizeSettings, normalizeState } from "./state.js";
import { drawnTimeRange } from "./times.js";
import { DEFAULT_URGENT_TERMS, byUrgency, triage } from "./triage.js";
import { HOUR, MINUTE, NOON, linkedInId, rawComment, rawNotification, rawPost } from "./testing/fakeBrowser.js";

const DAY = 24 * HOUR;
const account = { name: "Dana Reyes", slug: "dana-reyes" };

describe("ids", () => {
  it("read a post's URN out of every shape LinkedIn writes it in", () => {
    expect(parsePostUrn("urn:li:activity:7381234567890123456")).toEqual({ kind: "activity", id: "7381234567890123456", urn: "urn:li:activity:7381234567890123456" });
    expect(parsePostUrn("https://www.linkedin.com/feed/update/urn:li:ugcPost:7381111111111111111/?utm_source=share")?.urn).toBe("urn:li:ugcPost:7381111111111111111");
    expect(parsePostUrn("/feed/update/urn%3Ali%3Ashare%3A7381000000000000001")?.kind).toBe("share");
    expect(parsePostUrn("https://www.linkedin.com/posts/mila-novak_invoicing-activity-7381234567890123456-AbCd/")?.id).toBe("7381234567890123456");
    expect(parsePostUrn("https://www.linkedin.com/in/mila-novak/")).toBeUndefined();
  });

  it("read a comment's URN, plain, encoded, or written inside its parent", () => {
    const expected = { post: { kind: "activity", id: "7381234567890123456", urn: "urn:li:activity:7381234567890123456" }, id: "7381240000000000001" };
    expect(parseCommentUrn("urn:li:comment:(activity:7381234567890123456,7381240000000000001)")).toEqual(expected);
    expect(parseCommentUrn("urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000001%29")).toEqual(expected);
    expect(parseCommentUrn("urn:li:comment:(urn:li:activity:7381234567890123456,7381240000000000001)")).toEqual(expected);
    expect(parseCommentUrn("urn:li:comment:(urn:li:comment:(activity:7381234567890123456,7381240000000000001),7381240000000000002)")?.id).toBe("7381240000000000002");
    expect(parseCommentUrn("")).toBeUndefined();
  });

  it("read the time an id was made, and nothing from what is not an id", () => {
    expect(new Date(timeFromId("7381234567890123456")!).toISOString()).toBe("2025-10-07T07:50:57.691Z");
    expect(timeFromId(linkedInId(NOON))).toBe(NOON);
    expect(timeFromId("12345")).toBeUndefined();
    expect(timeFromId("1")).toBeUndefined();
    expect(timeFromId(undefined)).toBeUndefined();
  });

  it("make the links a person opens, encoded the way LinkedIn encodes them", () => {
    const post = parsePostUrn("urn:li:activity:7381234567890123456")!;
    expect(postUrl(post.urn)).toBe("https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/");
    expect(commentUrl(post, "7381240000000000001")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000001%29",
    );
    expect(commentUrl(post, "7381240000000000003", "7381240000000000002")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000002%29&replyUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000003%29",
    );
    expect(searchUrl('Acme OR "acme billing"')).toBe("https://www.linkedin.com/search/results/content/?keywords=Acme%20OR%20%22acme%20billing%22&sortBy=%22date_posted%22");
  });

  it("read an account in every form a person pastes it", () => {
    for (const value of ["https://www.linkedin.com/in/mila-novak/", "linkedin.com/in/mila-novak?trk=x", "https://de.linkedin.com/in/mila-novak", "in/mila-novak", "person:mila-novak", "mila-novak", "@mila-novak", { kind: "person", slug: "mila-novak" }]) {
      expect(normalizeAccount(value), JSON.stringify(value)).toEqual({ kind: "person", slug: "mila-novak" });
    }
    for (const value of ["https://www.linkedin.com/company/acme/posts/", "company/acme", "company:acme", { kind: "company", slug: "acme" }]) {
      expect(normalizeAccount(value), JSON.stringify(value)).toEqual({ kind: "company", slug: "acme" });
    }
    expect(normalizeAccount("https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller/")).toEqual({ kind: "person", slug: "jörg-müller" });
    expect(normalizeAccount("https://www.linkedin.com/feed/")).toBeUndefined();
    expect(normalizeAccount("not an account")).toBeUndefined();
    expect(accountFromUrl("https://example.com/in/mila-novak")).toBeUndefined();
    expect(accountKey({ kind: "person", slug: "Mila-Novak" })).toBe("account:person:mila-novak");
  });

  it("point at where an account's newest posts are drawn", () => {
    expect(activityUrl({ kind: "person", slug: "mila-novak" })).toBe("https://www.linkedin.com/in/mila-novak/recent-activity/all/");
    expect(sharesUrl({ kind: "person", slug: "mila-novak" })).toBe("https://www.linkedin.com/in/mila-novak/recent-activity/shares/");
    expect(activityUrl({ kind: "company", slug: "acme" })).toBe("https://www.linkedin.com/company/acme/posts/?feedView=all");
  });
});

describe("drawn times", () => {
  const at = NOON;

  it("become a range: the label is a floor, not a point", () => {
    expect(drawnTimeRange("3h", at)).toEqual({ earliest: at - 4 * HOUR, latest: at - 3 * HOUR });
    expect(drawnTimeRange("3h • Edited • ", at)).toEqual({ earliest: at - 4 * HOUR, latest: at - 3 * HOUR });
    expect(drawnTimeRange("5m", at)).toEqual({ earliest: at - 6 * MINUTE, latest: at - 5 * MINUTE });
    expect(drawnTimeRange("2mo", at)).toEqual({ earliest: at - 90 * DAY, latest: at - 60 * DAY });
    expect(drawnTimeRange("1yr", at)?.latest).toBe(at - 365 * DAY);
    expect(drawnTimeRange("1w", at)).toEqual({ earliest: at - 14 * DAY, latest: at - 7 * DAY });
    expect(drawnTimeRange("3 hours ago", at)).toEqual({ earliest: at - 4 * HOUR, latest: at - 3 * HOUR });
    expect(drawnTimeRange("now", at)).toEqual({ earliest: at - MINUTE, latest: at });
  });

  it("leave a date and another language alone", () => {
    expect(drawnTimeRange("Sep 30", at)).toBeUndefined();
    expect(drawnTimeRange("3 ч", at)).toBeUndefined();
    expect(drawnTimeRange("", at)).toBeUndefined();
  });
});

describe("drawn counts", () => {
  it("read comment counts exact and rounded", () => {
    expect(commentCount("23 comments on Mila Novak’s post")).toBe(23);
    expect(commentCount("1,204 comments")).toBe(1204);
    expect(commentCount("1.2K comments")).toBe(1200);
    expect(commentCount("")).toBeUndefined();
    expect(parseCount("2,3 тыс.")).toEqual({ value: 2300, approximate: true });
  });

  it("read reactions in each form LinkedIn draws them", () => {
    expect(reactionCount("1,234")).toBe(1234);
    expect(reactionCount("1,234 reactions")).toBe(1234);
    expect(reactionCount("Mila Novak and 41 others")).toBe(42);
    expect(reactionCount("Mila Novak")).toBe(1);
    expect(reactionCount("")).toBeUndefined();
  });
});

describe("items", () => {
  const raw = rawPost("Mila Novak", "Our   team\nloves it", { at: NOON - 2 * HOUR, comments_text: "3 comments", time_text: "2h • Edited •", reactions_text: "1,234", reposts_text: "4 reposts" });

  it("carry the author and the post, linked by URN and dated by id", () => {
    const [post] = normalizePosts([raw], NOON);
    const item = postItem(post!);
    expect(item).toMatchObject({
      key: `post:${post!.ref.id}`,
      author: "Mila Novak",
      authorKind: "person",
      authorUrl: "https://www.linkedin.com/in/mila-novak/",
      authorHeadline: "Works at Mila Co",
      url: postUrl(raw.urn),
      post: { id: post!.ref.id, urn: raw.urn, author: "Mila Novak", text: "Our team loves it" },
      replies: 3,
      reactions: 1234,
      reposts: 4,
      createdAt: NOON - 2 * HOUR,
      timeText: "2h",
    });
    const comment = commentItem(rawComment(raw, "Bo Chen", "agreed", { at: NOON - HOUR }), item.post, NOON)!;
    expect(comment).toMatchObject({ kind: "comment", createdAt: NOON - HOUR, post: { author: "Mila Novak" } });
    expect(comment.url).toBe(commentUrl(post!.ref, comment.id));
  });

  it("count no comments only where the action bar says so", () => {
    const [drawn, unknown] = normalizePosts([rawPost("A", "a"), rawPost("B", "b", { action_bar: false })], NOON);
    expect(drawn!.comments).toBe(0);
    expect(unknown!.comments).toBeUndefined();
  });

  it("know the account's own posts by public id, and by name when no profile was linked", () => {
    expect(isOwn({ author: "Someone", authorUrl: "https://www.linkedin.com/in/dana-reyes/" }, account)).toBe(true);
    expect(isOwn({ author: "Dana Reyes", authorUrl: "https://www.linkedin.com/in/dana-reyes-42/" }, account)).toBe(false);
    expect(isOwn({ author: "dana reyes" }, { name: "Dana Reyes" })).toBe(true);
  });

  it("find a mention by tag or by the full name, never by a first name", () => {
    expect(mentionsAccount("thanks!", [{ name: "D. R.", kind: "person", slug: "dana-reyes", url: "" }], account)).toBe(true);
    expect(mentionsAccount("ask Dana Reyes about it", [], account)).toBe(true);
    expect(mentionsAccount("ask Dana about it", [], account)).toBe(false);
  });
});

describe("notifications", () => {
  const post = rawPost("Lee Park", "Rolling out SSO");
  const comment = rawComment(post, "Mila Novak", "x", { at: NOON - HOUR });

  it("tell a mention, a reply and a comment on your post by their links and verbs", () => {
    expect(readNotification(rawNotification("Mila Novak", "Mila Novak mentioned you in a comment", post, { comment }), account, NOON).item).toMatchObject({
      kind: "comment", addressed: "mention", key: `comment:${parseCommentUrn(comment.urn)!.id}`, createdAt: NOON - HOUR,
    });
    const reply = rawComment(post, "Kim Ito", "y", { parent_urn: comment.urn });
    expect(readNotification(rawNotification("Kim Ito", "Kim Ito replied to your comment", post, { reply }), account, NOON).item).toMatchObject({ addressed: "reply" });
    expect(readNotification(rawNotification("Bo Chen", "Bo Chen commented on your post: “nice”", post, { comment }), account, NOON)).toMatchObject({
      ownPost: true, item: { addressed: "comment_on_post", post: { author: "Dana Reyes" } },
    });
  });

  it("skip what there is nothing to answer, and what links no post", () => {
    for (const headline of ["Bo Chen reacted to your post", "Kim Ito and 12 others liked your comment", "Your post appeared in 40 searches", "Lee Park started a new position", "Ana Lima reposted your post", "Wish Lee Park a happy birthday"]) {
      expect(readNotification(rawNotification("X", headline, post), account, NOON).skip, headline).toBeDefined();
    }
    expect(readNotification(rawNotification("X", "Jobs you may be interested in", post, { post_urn: "" }), account, NOON).skip).toBe("links no post");
  });

  it("report a card about several comments as no item of its own, and a card in another language by its link", () => {
    expect(readNotification(rawNotification("Bo Chen", "Bo Chen and 3 others commented on your post", post), account, NOON)).toEqual({ post: parsePostUrn(post.urn), ownPost: true });
    const german = readNotification(rawNotification("Mila Novak", "Mila Novak hat Sie in einem Kommentar erwähnt", post, { comment }), account, NOON);
    expect(german.item).toMatchObject({ kind: "comment", key: `comment:${parseCommentUrn(comment.urn)!.id}` });
    expect(german.item?.addressed).toBeUndefined();
  });

  it("key a card by what it says, so a rewritten card is new", () => {
    const one = rawNotification("Bo Chen", "Bo Chen commented on your post", post);
    expect(notificationKey(one)).toBe(notificationKey({ ...one }));
    expect(notificationKey(one)).not.toBe(notificationKey({ ...one, headline: "Bo Chen and 1 other commented on your post" }));
  });
});

describe("keywords and searches", () => {
  it("count a hashtag as a word, and nothing inside a longer word", () => {
    const match = keywordMatcher(["acme"]);
    expect(match("loving #acme today")).toEqual(["acme"]);
    expect(match("Acme's new pricing")).toEqual(["acme"]);
    expect(match("acmeshop")).toEqual([]);
  });

  it("search your company's names first, then the keywords, in at most maxSearches queries", () => {
    const terms = searchTerms(["Acme", "Acme Inc"], ["acme", "invoicing", "accounts payable"]);
    expect(terms).toEqual(["Acme", "Acme Inc", "invoicing", "accounts payable"]);
    expect(searchQueries(terms, 2)).toEqual(['Acme OR "Acme Inc" OR invoicing OR "accounts payable"']);
    const many = Array.from({ length: 14 }, (_, index) => `term${index}`);
    expect(searchQueries(many, 2)).toHaveLength(2);
    expect(searchQueries(many, 2).join(" OR ").split(" OR ")).toHaveLength(12);
    expect(searchQueries(many, 3)).toHaveLength(3);
    expect(searchQueries(terms, 0)).toEqual([]);
    expect(signature(["b", "A"])).toBe("a|b");
  });
});

const urgent = keywordMatcher([...DEFAULT_URGENT_TERMS]);
const [post] = normalizePosts([rawPost("Lee Park", "Is Acme down? Our invoicing has an outage", { comments_text: "" })], NOON);

describe("triage", () => {
  it("ranks a company mention with an urgent term high", () => {
    expect(triage(postItem(post!, undefined, "Acme"), { keywords: [], urgent })).toEqual({
      urgency: "high", score: 8, reasons: ["Mentions your company", 'Says "outage"', "Asks a question", "No comments yet"],
    });
  });

  it("counts an urgent term only in an item about you", () => {
    expect(triage(postItem(post!), { keywords: [], urgent }).reasons).toEqual(["Asks a question"]);
  });

  it("ranks a mention and a reply high, a comment on your post medium", () => {
    const context = postItem(post!).post;
    const comment = (addressed: "mention" | "reply" | "comment_on_post") => commentItem(rawComment(rawPost("Dana Reyes", "x"), "Kim Ito", "thanks for this"), context, NOON, { addressed })!;
    expect(triage(comment("mention"), { keywords: [], urgent })).toEqual({ urgency: "high", score: 4, reasons: ["Mentions you"] });
    expect(triage(comment("reply"), { keywords: [], urgent })).toEqual({ urgency: "high", score: 4, reasons: ["Replies to your comment"] });
    expect(triage(comment("comment_on_post"), { keywords: [], urgent })).toEqual({ urgency: "medium", score: 2, reasons: ["Comments on your post"] });
  });

  it("calls a request for a recommendation a lead", () => {
    const [lead] = normalizePosts([rawPost("Ana Lima", "Looking for an alternative to our CRM", { comments_text: "4 comments" })], NOON);
    expect(triage(postItem(lead!), { keywords: [], urgent })).toEqual({ urgency: "medium", score: 2, reasons: ["Asks for a recommendation"] });
    const [quiet] = normalizePosts([rawPost("Ana Lima", "Who do you use for payroll in Portugal?")], NOON);
    expect(triage(postItem(quiet!), { keywords: [], urgent })).toEqual({ urgency: "high", score: 4, reasons: ["Asks for a recommendation", "Asks a question", "No comments yet"] });
  });

  it("notices a post picking up fast", () => {
    const [busy] = normalizePosts([rawPost("A", "launch day", { comments_text: "140 comments" })], NOON);
    expect(triage(postItem(busy!), { keywords: [], urgent, gained: 35 }).reasons).toEqual(["35 comments since the last look"]);
    expect(triage(postItem(busy!), { keywords: [], urgent, gained: 29 }).reasons).toEqual([]);
  });

  it("sorts most urgent first, then newest", () => {
    const entry = (hoursAgo: number, urgency: "high" | "low", score: number) => {
      const [made] = normalizePosts([rawPost("A", String(hoursAgo), { at: NOON - hoursAgo * HOUR })], NOON);
      return { item: postItem(made!), triage: { urgency, score, reasons: [] } };
    };
    expect([entry(3, "low", 0), entry(2, "high", 4), entry(1, "low", 0)].sort(byUrgency).map((e) => e.item.text)).toEqual(["2", "1", "3"]);
  });
});

describe("freshness", () => {
  const since = NOON;
  const readAt = NOON + 2 * HOUR;
  const maxAge = 72 * HOUR;

  it("goes by the id's time when there is one", () => {
    expect(freshItem(NOON + HOUR, undefined, since, readAt, maxAge, false)).toBe(true);
    expect(freshItem(NOON - HOUR, undefined, since, readAt, maxAge, true)).toBe(false);
    expect(freshComment(NOON + HOUR, undefined, since, readAt, maxAge, false)).toBe(true);
  });

  it("falls back to the drawn time, then to the position", () => {
    expect(freshItem(undefined, { earliest: NOON + 30 * MINUTE, latest: NOON + HOUR }, since, readAt, maxAge, false)).toBe(true);
    expect(freshItem(undefined, { earliest: NOON - 2 * DAY, latest: NOON - DAY }, since, readAt, maxAge, true)).toBe(false);
    expect(freshItem(undefined, undefined, since, readAt, maxAge, true)).toBe(true);
    expect(freshItem(undefined, undefined, since, readAt, maxAge, false)).toBe(false);
    expect(freshComment(undefined, undefined, since, readAt, maxAge, true)).toBe(true);
  });
});

describe("state", () => {
  it("clamps settings to safe ranges", () => {
    const settings = normalizeSettings({
      maxCommentReads: 500, maxScrolls: 99, maxSearches: 9,
      accounts: ["in/mila-novak", "https://www.linkedin.com/in/MILA-NOVAK/", "bad account!", ...Array.from({ length: 12 }, (_, i) => `company/c${i}`)],
      companyNames: ["Acme", "acme", "Acme Inc", "A", "B2", "C3", "D4", "E5"],
    });
    expect(settings).toMatchObject({ maxCommentReads: 8, maxScrolls: 4, maxSearches: 3 });
    expect(settings.accounts).toHaveLength(10);
    expect(settings.accounts[0]).toEqual({ kind: "person", slug: "mila-novak" });
    expect(settings.companyNames).toEqual(["Acme", "Acme Inc", "B2", "C3", "D4"]);
    expect(normalizeSettings({})).toMatchObject({ maxItemAgeMs: 72 * HOUR, maxSearches: 2, maxScrolls: 2, maxCommentReads: 4, watchNotifications: true, watchComments: true, searchKeywords: true });
    expect(normalizeSettings({ urgentTerms: [] }).urgentTerms).toEqual([]);
    expect(normalizeSettings({}).urgentTerms).toEqual(DEFAULT_URGENT_TERMS);
  });

  it("accepts whatever was on disk", () => {
    expect(normalizeState(null)).toEqual(emptyState());
    const state = normalizeState({
      account: { handle: "dana-reyes", name: "Dana Reyes", slug: "dana-reyes", signedIn: true, checkedAt: 5 },
      sources: { notifications: { since: 1, filter: "" }, "account:person:mila-novak": { since: 1, filter: "all", name: "Mila Novak" }, "search:acme": { since: 1, filter: "acme" }, other: { since: 1 }, "account:planet:x": { since: 1 } },
      posts: {
        "7381234567890123456": { urn: "urn:li:activity:7381234567890123456", source: "notifications", own: true, due: true, checkedAt: 1 },
        "7381234567890123457": { urn: "urn:li:activity:1", source: "x", comments: 1 },
        junk: { comments: 1 },
      },
      seen: ["post:1", 2],
    });
    expect(state.account).toEqual({ handle: "dana-reyes", name: "Dana Reyes", slug: "dana-reyes", signedIn: true, checkedAt: 5 });
    expect(Object.keys(state.sources)).toEqual(["notifications", "account:person:mila-novak", "search:acme"]);
    expect(state.posts).toEqual({ "7381234567890123456": { urn: "urn:li:activity:7381234567890123456", source: "notifications", own: true, due: true, checkedAt: 1 } });
    expect(state.seen).toEqual(["post:1"]);
  });
});

describe("scheduleDelay", () => {
  it("spreads the interval, never goes under thirty minutes, and backs off after a stop", () => {
    expect(scheduleDelay(undefined, { random: () => 0.5 })).toBe(60 * MINUTE);
    expect(scheduleDelay(MINUTE, { random: () => 0.5 })).toBe(30 * MINUTE);
    expect(scheduleDelay(60 * MINUTE, { random: () => 0.5, backOff: true })).toBe(180 * MINUTE);
  });
});
