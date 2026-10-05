import { beforeEach, describe, expect, it } from "vitest";
import { checkAccount, runPass, type PassDeps, type PassResult } from "./engine.js";
import type { MonitorEvent, NewItemEvent } from "./events.js";
import { NOTIFICATIONS_URL, activityUrl, commentUrl, parseCommentUrn, parsePostUrn, postUrl, searchUrl, sharesUrl } from "./ids.js";
import { SIGN_IN_URL, type RawComment, type RawPost } from "./scripts.js";
import { emptyState, withSettings, type MonitorSettings, type MonitorState } from "./state.js";
import { FakeLinkedIn, HOUR, MINUTE, NOON, rawComment, rawNotification, rawPost } from "./testing/fakeBrowser.js";

const MILA = { kind: "person" as const, slug: "mila-novak" };
const QUERY = "Acme OR invoicing";

let clock = NOON;
let li: FakeLinkedIn;
let sleeps: number[];
let older: RawPost;

beforeEach(() => {
  clock = NOON;
  sleeps = [];
  li = new FakeLinkedIn();
  older = rawPost("Mila Novak", "Notes from a week of closing the books", { at: NOON - 5 * HOUR, comments_text: "2 comments" });
  li.accounts["in/mila-novak"] = { name: "Mila Novak", posts: [older] };
});

function pass(state: MonitorState, extra: Partial<PassDeps> = {}): Promise<PassResult> {
  return runPass({
    browser: li,
    state,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    ...extra,
  });
}

function watching(patch: Partial<MonitorSettings> | Record<string, unknown> = {}): MonitorState {
  return emptyState({ accounts: ["https://www.linkedin.com/in/mila-novak/"], companyNames: ["Acme"], keywords: ["invoicing"], ...patch });
}

const types = (events: MonitorEvent[]) => events.map((event) => event.type);
const fresh = (events: MonitorEvent[]) => events.filter((event): event is NewItemEvent => event.type === "new_item");
const texts = (events: MonitorEvent[]) => fresh(events).map((event) => event.item.text);
const idOf = (post: RawPost) => parsePostUrn(post.urn)!.id;

/** later moves the clock to the next pass. */
function later(minutes = 60): void {
  clock += minutes * MINUTE;
}

/** soon is a moment between the last pass and the next. */
const soon = (minutesAgo = 10) => clock - minutesAgo * MINUTE;

/** publish puts new posts on top of a watched account's activity. */
function publish(account: string, ...posts: RawPost[]): void {
  li.accounts[account]!.posts = [...posts, ...li.accounts[account]!.posts];
}

/** grow adds comments under a post and raises the count its feed unit draws. */
function grow(target: RawPost, ...added: RawComment[]): void {
  const thread = li.threads[idOf(target)] ?? { post: target, comments: [] };
  thread.comments = [...thread.comments, ...added];
  li.threads[idOf(target)] = thread;
  const count = (Number.parseInt(target.comments_text, 10) || 0) + added.length;
  target.comments_text = `${count} comments`;
}

describe("the first pass", () => {
  it("signs in, records every source as its starting line, and announces nothing", async () => {
    li.searchable = [rawPost("Lee Park", "Acme or the other one for invoicing?", { at: NOON - 2 * HOUR })];
    const { state, events, summary, matches } = await pass(watching());

    expect(types(events)).toEqual(["signed_in"]);
    expect(events[0]).toEqual({ type: "signed_in", at: NOON, handle: "Dana Reyes", name: "Dana Reyes" });
    expect(summary).toMatchObject({ signedIn: true, handle: "Dana Reyes", sourcesRead: 3, baselines: 3, newItems: 0, searches: 1, commentReads: 0 });
    expect(Object.keys(state.sources).sort()).toEqual(["account:person:mila-novak", "notifications", "search:acme or invoicing"]);
    expect(state.sources["account:person:mila-novak"]).toMatchObject({ since: NOON, name: "Mila Novak", filter: "all" });
    expect(state.sources["search:acme or invoicing"]).toMatchObject({ since: NOON, filter: "acme|invoicing" });
    expect(li.opened).toEqual([NOTIFICATIONS_URL, activityUrl(MILA), searchUrl(QUERY), "about:blank"]);
    // The dashboard still gets what matched.
    expect(matches.map((match) => match.item.text)).toEqual(["Acme or the other one for invoicing?", "Notes from a week of closing the books"]);
  });

  it("never mutates the state it was given", async () => {
    const given = watching();
    const copy = structuredClone(given);
    await pass(Object.freeze(given));
    later();
    publish("in/mila-novak", rawPost("Mila Novak", "New quarter, new invoicing stack", { at: soon() }));
    await pass(Object.freeze(given));
    expect(given).toEqual(copy);
  });

  it("opens nothing with nothing to watch, and says what to add", async () => {
    const { summary } = await pass(emptyState({ watchNotifications: false }));
    expect(li.opened).toEqual([]);
    expect(summary.notes).toEqual(["Nothing to watch: turn on notifications, add up to 10 accounts, or add your company's name and keywords to search for."]);
  });

  it("says so when there is nothing to search for", async () => {
    const { summary } = await pass(emptyState({ accounts: ["in/mila-novak"] }));
    expect(summary.notes[0]).toContain("No company names or keywords");
    expect(li.searches).toEqual([]);
  });
});

describe("watched accounts", () => {
  it("announces a watched account's new post, with its author and post in context", async () => {
    const first = await pass(watching());
    later();
    const at = soon();
    const post = rawPost("Mila Novak", "We are hiring a payments engineer in Lisbon", { at });
    publish("in/mila-novak", post);
    const { events, summary } = await pass(first.state);

    expect(fresh(events)).toHaveLength(1);
    expect(fresh(events)[0]).toMatchObject({
      account: "Dana Reyes",
      source: { kind: "account", name: "Mila Novak", account: MILA },
      keywords: [],
      item: {
        key: `post:${idOf(post)}`,
        kind: "post",
        author: "Mila Novak",
        authorHeadline: "Works at Mila Co",
        authorUrl: "https://www.linkedin.com/in/mila-novak/",
        url: postUrl(post.urn),
        post: { id: idOf(post), urn: post.urn, url: postUrl(post.urn), author: "Mila Novak", text: "We are hiring a payments engineer in Lisbon" },
        createdAt: at,
      },
      triage: { urgency: "low", reasons: [] },
    });
    expect(summary).toMatchObject({ newItems: 1, urgent: 0, baselines: 0 });
  });

  it("dates a post by its id, so an old post drawn on top is not new", async () => {
    const first = await pass(watching());
    later();
    publish("in/mila-novak", rawPost("Mila Novak", "Featured: our 2025 report", { at: NOON - 30 * HOUR }), rawPost("Mila Novak", "Fresh thoughts on invoicing", { at: soon() }));
    expect(texts((await pass(first.state)).events)).toEqual(["Fresh thoughts on invoicing"]);
  });

  it("scrolls back to known ground when many posts arrived", async () => {
    li.pageSize = 2;
    const first = await pass(watching({ accounts: ["in/mila-novak"], companyNames: [], keywords: [] }));
    later();
    publish("in/mila-novak", ...[5, 4, 3].map((minutes) => rawPost("Mila Novak", `post ${minutes}`, { at: soon(minutes) })));
    const { events, summary } = await pass(first.state);
    expect(texts(events)).toEqual(["post 5", "post 4", "post 3"]);
    expect(summary.scrolls).toBeGreaterThan(0);
  });

  it("falls back to the posts tab when the activity page draws nothing", async () => {
    const first = await pass(watching());
    li.accounts["in/mila-novak"]!.page = "blank";
    later();
    publish("in/mila-novak", rawPost("Mila Novak", "Shipping notes", { at: soon() }));
    const { events, summary, state } = await pass(first.state);
    expect(li.opened).toContain(sharesUrl(MILA));
    expect(texts(events)).toEqual(["Shipping notes"]);
    expect(summary).toMatchObject({ fallbacks: 1, unreadable: 0 });
    expect(summary.notes).toContain("Mila Novak was read from the posts tab: the activity page drew nothing.");
    expect(state.sources["account:person:mila-novak"]?.fallback).toBe(true);
  });

  it("notes an account LinkedIn drew no posts for, and goes on with the rest", async () => {
    const first = await pass(watching());
    li.accounts["in/mila-novak"]!.page = "blank";
    li.accounts["in/mila-novak"]!.shares = "blank";
    later();
    li.searchable = [rawPost("Lee Park", "Acme just raised prices", { at: soon() })];
    const { events, summary, state } = await pass(first.state);
    expect(summary.notes).toContain("LinkedIn drew no posts for Mila Novak this pass; it is tried again on the next one.");
    expect(summary).toMatchObject({ unreadable: 1, searches: 1 });
    expect(texts(events)).toEqual(["Acme just raised prices"]);
    expect(state.sources["account:person:mila-novak"]).toMatchObject({ since: NOON, note: expect.stringContaining("drew no posts") });
  });

  it("reads a company's posts, and an account that says it has none", async () => {
    li.accounts["company/acme"] = { name: "Acme", posts: [rawPost("Acme", "Acme 4.0 is here", { company: true, at: NOON - 3 * HOUR })] };
    li.accounts["in/quiet-person"] = { name: "Quiet Person", posts: [], page: "empty" };
    const { summary, state } = await pass(watching({ accounts: ["https://www.linkedin.com/company/acme/", "in/quiet-person"] }));
    expect(li.opened).toContain("https://www.linkedin.com/company/acme/posts/?feedView=all");
    expect(li.opened).not.toContain("https://www.linkedin.com/in/quiet-person/recent-activity/shares/");
    expect(summary).toMatchObject({ unreadable: 0 });
    expect(state.sources["account:company:acme"]).toMatchObject({ name: "Acme" });
    expect(state.sources["account:person:quiet-person"]).toBeDefined();
  });

  it("notes an account that is not there", async () => {
    const { summary } = await pass(watching({ accounts: ["in/no-such-person"] }));
    expect(summary.notes).toContain("in/no-such-person was not found, or is not visible to this account: check the link.");
    expect(summary.unreadable).toBe(1);
  });
});

describe("search", () => {
  it("ranks a post that names your company high, with the reasons, and re-matches LinkedIn's fuzzy results", async () => {
    const first = await pass(watching());
    later();
    const outage = rawPost("Lee Park", "Acme had an outage again this morning, anyone else seeing this?", { at: soon() });
    li.searchable = [outage, rawPost("Bo Chen", "The acmeshop sale ends today", { at: soon(5) })];
    const { events } = await pass(first.state);
    expect(fresh(events)).toHaveLength(1);
    expect(fresh(events)[0]).toMatchObject({
      source: { kind: "search", name: QUERY, query: QUERY },
      keywords: [],
      item: { kind: "post", author: "Lee Park", company: "Acme", url: postUrl(outage.urn), replies: 0 },
      triage: { urgency: "high", reasons: ["Mentions your company", 'Says "outage"', "Asks a question", "No comments yet"] },
    });
  });

  it("calls a request for a recommendation a lead: medium on its own, high when it names you", async () => {
    const first = await pass(watching());
    later();
    li.searchable = [
      rawPost("Ana Lima", "Looking for recommendations on an invoicing tool for a 20-person agency", { at: soon(20) }),
      rawPost("Sam Ortiz", "Who do you use for invoicing? Acme keeps timing out on us", { at: soon(10) }),
    ];
    const { events } = await pass(first.state);
    expect(fresh(events).map((event) => [event.item.author, event.triage.urgency, event.triage.reasons])).toEqual([
      ["Ana Lima", "medium", ["Asks for a recommendation", "No comments yet"]],
      ["Sam Ortiz", "high", ["Mentions your company", "Asks for a recommendation", "Asks a question", "No comments yet"]],
    ]);
  });

  it("starts a new starting line when the terms change", async () => {
    const first = await pass(watching());
    later();
    li.searchable = [rawPost("Lee Park", "Contoso billing is great", { at: soon() })];
    const changed = await pass(withSettings(first.state, { keywords: ["contoso"] }));
    expect(fresh(changed.events)).toHaveLength(0);
    expect(changed.summary.baselines).toBe(1);
    expect(Object.keys(changed.state.sources)).not.toContain("search:acme or invoicing");
    expect(changed.state.sources["search:acme or contoso"]).toBeDefined();
  });

  it("skips the searches at LinkedIn's search limit and reads everything else", async () => {
    const watched = rawPost("Mila Novak", "Our invoicing migration, part 2", { at: NOON - 2 * HOUR, comments_text: "1 comment" });
    publish("in/mila-novak", watched);
    const first = await pass(watching());
    later();
    li.searchLimit = "You’ve reached the commercial use limit on search";
    grow(watched, rawComment(watched, "Bo Chen", "Which invoicing vendor did you pick?", { at: soon() }));
    const { events, summary, state } = await pass(first.state);
    expect(summary).toMatchObject({ searchLimited: true, rateLimited: false, searches: 0, commentReads: 1 });
    expect(summary.blocked).toBeUndefined();
    expect(summary.notes.some((note) => note.includes("search limit is reached"))).toBe(true);
    expect(texts(events)).toEqual(["Which invoicing vendor did you pick?"]);
    expect(state.sources["search:acme or invoicing"]).toEqual(first.state.sources["search:acme or invoicing"]);
  });

  it("does not announce the account's own posts", async () => {
    const first = await pass(watching());
    later();
    li.searchable = [rawPost("Dana Reyes", "Acme 4.0 is out!", { at: soon() })];
    expect(fresh((await pass(first.state)).events)).toHaveLength(0);
  });

  it("drops a post with an exclusion word, unless it mentions the account", async () => {
    const first = await pass(watching({ excludeKeywords: ["giveaway"] }));
    later();
    li.searchable = [
      rawPost("Spam Bot", "Acme giveaway click here", { at: soon(20) }),
      rawPost("Kim Ito", "Dana Reyes, is the Acme giveaway real?", { at: soon(10) }),
    ];
    expect(texts((await pass(first.state)).events)).toEqual(["Dana Reyes, is the Acme giveaway real?"]);
  });
});

describe("notifications", () => {
  let thread: RawPost;

  beforeEach(() => {
    thread = rawPost("Lee Park", "Rolling out SSO across 40 tools this quarter", { at: NOON - 3 * HOUR, comments_text: "6 comments" });
  });

  it("announces a mention high, with the post it is on", async () => {
    const first = await pass(watching());
    later();
    const comment = rawComment(thread, "Mila Novak", "Dana Reyes can you check the SSO setup?", {
      at: soon(),
      mentions: [{ name: "Dana Reyes", kind: "person", slug: "dana-reyes", url: "https://www.linkedin.com/in/dana-reyes/" }],
    });
    li.threads[idOf(thread)] = { post: thread, comments: [comment] };
    li.notifications = [rawNotification("Mila Novak", "Mila Novak mentioned you in a comment: “Dana Reyes can you check the SSO setup?”", thread, {
      comment,
      snippet: "Dana Reyes can you check the SSO setup?",
    })];
    const { events, summary } = await pass(first.state);

    expect(li.threadsRead).toEqual([idOf(thread)]);
    expect(fresh(events)).toHaveLength(1);
    const commentId = parseCommentUrn(comment.urn)!.id;
    expect(fresh(events)[0]).toMatchObject({
      source: { kind: "notifications", name: "notifications" },
      item: {
        key: `comment:${commentId}`,
        kind: "comment",
        author: "Mila Novak",
        addressed: "mention",
        text: "Dana Reyes can you check the SSO setup?",
        url: commentUrl(parsePostUrn(thread.urn)!, commentId),
        post: { id: idOf(thread), author: "Lee Park", text: "Rolling out SSO across 40 tools this quarter" },
      },
      triage: { urgency: "high", reasons: ["Mentions you", "Asks a question"] },
    });
    expect(summary).toMatchObject({ newItems: 1, urgent: 1, commentReads: 1 });

    later();
    expect(fresh((await pass((await pass(first.state)).state)).events)).toHaveLength(0);
  });

  it("announces a reply to the account's comment", async () => {
    const first = await pass(watching());
    later();
    const mine = rawComment(thread, "Dana Reyes", "We did this with Okta last year", { at: NOON - 2 * HOUR });
    const reply = rawComment(thread, "Kim Ito", "Did you keep SCIM on?", { at: soon(), parent_urn: mine.urn });
    li.threads[idOf(thread)] = { post: thread, comments: [mine, reply] };
    li.notifications = [rawNotification("Kim Ito", "Kim Ito replied to your comment: “Did you keep SCIM on?”", thread, { reply, snippet: "Did you keep SCIM on?" })];
    const { events } = await pass(first.state);
    const replyId = parseCommentUrn(reply.urn)!.id;
    expect(fresh(events)).toHaveLength(1);
    expect(fresh(events)[0]).toMatchObject({
      item: {
        addressed: "reply",
        url: commentUrl(parsePostUrn(thread.urn)!, replyId, parseCommentUrn(mine.urn)!.id),
        parent: { author: "Dana Reyes", text: "We did this with Okta last year" },
      },
      triage: { urgency: "high", reasons: ["Replies to your comment", "Asks a question"] },
    });
  });

  it("reads every comment on the account's own post when a card only counts them", async () => {
    const own = rawPost("Dana Reyes", "We just shipped SSO for every plan", { at: NOON - 4 * HOUR, comments_text: "3 comments" });
    const first = await pass(watching());
    later();
    li.threads[idOf(own)] = {
      post: own,
      comments: [
        rawComment(own, "Early Bird", "Nice!", { at: NOON - 3 * HOUR }),
        rawComment(own, "Bo Chen", "Does this work with Okta?", { at: soon(30) }),
        rawComment(own, "Kim Ito", "Congrats on the launch", { at: soon(20) }),
      ],
    };
    li.notifications = [rawNotification("Bo Chen", "Bo Chen and 1 other commented on your post", own)];
    const { events } = await pass(first.state);
    expect(fresh(events).map((event) => [event.item.author, event.item.addressed, event.triage.urgency])).toEqual([
      ["Bo Chen", "comment_on_post", "medium"],
      ["Kim Ito", "comment_on_post", "medium"],
    ]);
    expect(fresh(events)[0]!.item.post).toMatchObject({ author: "Dana Reyes", text: "We just shipped SSO for every plan" });
    expect(fresh(events)[0]!.source).toEqual({ kind: "comments", name: "notifications" });
  });

  it("reports a post found by a notification and by a watched account once, with its text", async () => {
    const first = await pass(watching());
    later();
    const post = rawPost("Mila Novak", "Dana Reyes, is SSO with Okta on the roadmap for this quarter?", { at: soon(), comments_text: "2 comments" });
    publish("in/mila-novak", post);
    li.searchable = [post];
    li.notifications = [rawNotification("Mila Novak", "Mila Novak mentioned you in a post", post)];
    const { events, matches } = await pass({ ...first.state, settings: { ...first.state.settings, keywords: ["okta"] } });
    expect(fresh(events)).toHaveLength(1);
    expect(fresh(events)[0]).toMatchObject({
      source: { kind: "notifications" },
      item: { kind: "post", addressed: "mention", author: "Mila Novak", text: "Dana Reyes, is SSO with Okta on the roadmap for this quarter?", replies: 2 },
      keywords: ["okta"],
      triage: { urgency: "high", reasons: ["Mentions you", "Asks a question"] },
    });
    expect(matches.filter((match) => match.item.key === `post:${idOf(post)}`)).toHaveLength(1);
  });

  it("skips what there is nothing to answer, and takes no card as new on the first read", async () => {
    li.notifications = [rawNotification("Kim Ito", "Kim Ito mentioned you in a post", thread)];
    const first = await pass(watching());
    expect(fresh(first.events)).toHaveLength(0);
    later();
    li.notifications = [
      rawNotification("Bo Chen", "Bo Chen reacted to your post", thread),
      rawNotification("Lee Park", "Lee Park viewed your profile", thread, { post_urn: "" }),
      ...li.notifications,
    ];
    const { events, summary } = await pass(first.state);
    expect(fresh(events)).toHaveLength(0);
    expect(summary.commentReads).toBe(0);
  });
});

describe("comments", () => {
  let watched: RawPost;

  beforeEach(() => {
    watched = rawPost("Mila Novak", "Our team moved invoicing to a new vendor", { at: NOON - 2 * HOUR, comments_text: "2 comments" });
    publish("in/mila-novak", watched);
  });

  it("opens a post only when its comment count grew, and announces a matching comment once", async () => {
    const first = await pass(watching());
    expect(first.state.posts[idOf(watched)]).toMatchObject({ comments: 2, source: "account:person:mila-novak", own: false });
    later();
    expect(li.threadsRead).toEqual([]);
    grow(watched, rawComment(watched, "Bo Chen", "Which vendor? We are on Acme and the exports are broken", { at: soon() }), rawComment(watched, "Ana Lima", "same", { at: soon(5) }));
    const second = await pass(first.state);
    expect(li.threadsRead).toEqual([idOf(watched)]);
    expect(fresh(second.events)).toHaveLength(1);
    expect(fresh(second.events)[0]).toMatchObject({
      source: { kind: "comments", name: "Mila Novak", account: MILA },
      item: { kind: "comment", author: "Bo Chen", company: "Acme", post: { id: idOf(watched), author: "Mila Novak" } },
      triage: { urgency: "high", reasons: ["Mentions your company", 'Says "broken"', "Asks a question"] },
    });
    expect(second.state.posts[idOf(watched)]).toMatchObject({ comments: 4, threadReadAt: second.state.lastPass!.at });

    later();
    const third = await pass(second.state);
    expect(li.threadsRead).toEqual([idOf(watched)]);
    expect(fresh(third.events)).toHaveLength(0);

    later();
    grow(watched, rawComment(watched, "Cy Diaz", "Acme support fixed it for us", { at: soon() }));
    expect(texts((await pass(third.state)).events)).toEqual(["Acme support fixed it for us"]);
  });

  it("opens no more posts than allowed, and catches up on the next pass", async () => {
    const other = rawPost("Mila Novak", "Invoicing tools we tried in 2026", { at: NOON - HOUR, comments_text: "1 comment" });
    publish("in/mila-novak", other);
    const first = await pass(watching({ maxCommentReads: 1 }));
    later();
    grow(other, rawComment(other, "A", "Acme wins on price", { at: soon() }));
    grow(watched, rawComment(watched, "B", "Acme billing is solid", { at: soon() }));
    const middle = await pass(first.state);
    expect(texts(middle.events)).toEqual(["Acme wins on price"]);
    expect(middle.summary).toMatchObject({ commentReads: 1, commentReadsDeferred: 1 });
    expect(middle.summary.notes).toContain("1 post with new comments waits for the next pass (maxCommentReads).");
    expect(middle.state.posts[idOf(watched)]?.due).toBe(true);
    later();
    const last = await pass(middle.state);
    expect(texts(last.events)).toEqual(["Acme billing is solid"]);
    expect(last.state.posts[idOf(watched)]?.due).toBeUndefined();
  });

  it("keeps a post whose comments could not be read, and reads it on the next pass", async () => {
    const first = await pass(watching());
    later();
    grow(watched, rawComment(watched, "Bo Chen", "Acme invoicing question", { at: soon() }));
    li.failThreads.add(idOf(watched));
    const failed = await pass(first.state);
    expect(fresh(failed.events)).toHaveLength(0);
    expect(failed.summary.notes).toContain("The comments on a post could not be read; they are read again on the next pass.");
    expect(failed.state.posts[idOf(watched)]).toMatchObject({ comments: 2, due: true });
    li.failThreads.clear();
    later();
    expect(texts((await pass(failed.state)).events)).toEqual(["Acme invoicing question"]);
  });

  it("keeps a post whose page drew none of its new comments due, then gives up after a few tries", async () => {
    const first = await pass(watching());
    later();
    grow(watched, rawComment(watched, "Bo Chen", "Acme invoicing question", { at: soon() }));
    li.hideComments.add(idOf(watched));
    const empty = await pass(first.state);
    expect(fresh(empty.events)).toHaveLength(0);
    expect(empty.summary.notes).toContain("A post's page drew none of its new comments; they are read again on the next pass.");
    expect(empty.state.posts[idOf(watched)]).toMatchObject({ comments: 2, due: true, emptyReads: 1 });
    li.hideComments.clear();
    later();
    const read = await pass(empty.state);
    expect(texts(read.events)).toEqual(["Acme invoicing question"]);

    later();
    grow(watched, rawComment(watched, "Cy Diaz", "Acme again", { at: soon() }));
    li.hideComments.add(idOf(watched));
    let state = read.state;
    const notes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await pass(state);
      notes.push(...result.summary.notes);
      state = result.state;
      later();
    }
    expect(notes).toContain("A post's page drew none of its comments 3 times in a row; its count moves on without them.");
    expect(state.posts[idOf(watched)]).toMatchObject({ comments: 4 });
    expect(state.posts[idOf(watched)]?.due).toBeUndefined();
  });

  it("reads the comments of a post that is itself new", async () => {
    const first = await pass(watching());
    later();
    const post = rawPost("Mila Novak", "Invoicing or not?", { at: soon(30) });
    publish("in/mila-novak", post);
    grow(post, rawComment(post, "Bo Chen", "Acme, no question", { at: soon(10) }));
    expect(texts((await pass(first.state)).events)).toEqual(["Invoicing or not?", "Acme, no question"]);
  });

  it("reads no comments with watchComments off", async () => {
    const first = await pass(watching({ watchComments: false }));
    later();
    grow(watched, rawComment(watched, "Bo Chen", "Acme", { at: soon() }));
    await pass(first.state);
    expect(li.threadsRead).toEqual([]);
  });
});

describe("degraded states", () => {
  it("stops at a signed-out profile, says so once, and picks up after a sign-in", async () => {
    const first = await pass(watching());
    li.signedIn = false;
    later();
    const out = await pass(first.state);
    expect(types(out.events)).toEqual(["signed_out"]);
    expect(out.summary).toMatchObject({ signedIn: false, loginRequired: true, pagesLoaded: 1 });
    expect(out.state.sources).toEqual(first.state.sources);
    later();
    const still = await pass(out.state);
    expect(types(still.events)).toEqual([]);
    li.signedIn = true;
    later();
    const back = await pass(still.state);
    expect(types(back.events)).toEqual(["signed_in"]);
  });

  it("stops at a security check and asks for it to be done by hand", async () => {
    const first = await pass(watching());
    li.checkpoint = true;
    later();
    const { events, summary } = await pass(first.state);
    expect(types(events)).toEqual(["security_check"]);
    expect(summary).toMatchObject({ securityCheck: true, pagesLoaded: 1 });
    expect(summary.blocked).toContain("security check");
    expect(li.opened.at(-1)).toBe("about:blank");
  });

  it("stops at a restriction, keeping and announcing what was read before it", async () => {
    const first = await pass(watching());
    later();
    const comment = rawComment(rawPost("Lee Park", "x"), "Kim Ito", "Dana Reyes thoughts?", { at: soon() });
    li.notifications = [rawNotification("Kim Ito", "Kim Ito mentioned you in a comment", rawPost("Lee Park", "x"), { comment, post_urn: `urn:li:activity:${parseCommentUrn(comment.urn)!.post.id}` })];
    const { events, summary, state } = await pass(first.state, {
      onStep: (step) => {
        if (step.startsWith("Searching")) li.restricted = "You’ve reached the weekly limit";
      },
    });
    expect(summary.rateLimited).toBe(true);
    expect(summary.blocked).toContain("You’ve reached the weekly limit");
    expect(texts(events)).toEqual(["Kim Ito mentioned you in a comment"]);
    expect(state.sources["search:acme or invoicing"]).toEqual(first.state.sources["search:acme or invoicing"]);
    expect(summary.commentReads).toBe(0);
  });

  it("treats LinkedIn's HTTP 999 as a restriction", async () => {
    li.restricted = "HTTP 999";
    const { summary } = await pass(watching());
    expect(summary).toMatchObject({ rateLimited: true, pagesLoaded: 1 });
    expect(summary.blocked).toContain("HTTP 999");
  });

  it("stops when linkedin.com cannot be reached", async () => {
    li.networkError = "ERR_NAME_NOT_RESOLVED";
    const { summary } = await pass(watching());
    expect(summary).toMatchObject({ rateLimited: false, loginRequired: false });
    expect(summary.blocked).toContain("could not be reached (ERR_NAME_NOT_RESOLVED)");
    const failing = { ...li, open: async () => { throw new Error("nbc open failed: CDP_UNREACHABLE"); } } as unknown as FakeLinkedIn;
    const result = await runPass({ browser: failing, state: watching(), sleep: async () => undefined, random: () => 0.5 });
    expect(result.summary.blocked).toContain("could not open linkedin.com (nbc open failed: CDP_UNREACHABLE)");
  });

  it("pauses like a person between page loads and scrolls", async () => {
    const first = await pass(watching());
    later();
    sleeps = [];
    await pass(first.state);
    const pauses = sleeps.filter((ms) => ms >= 1000);
    expect(pauses).toContain(10_000);
    expect(pauses.every((ms) => ms >= 1_500 && ms <= 14_000)).toBe(true);
  });
});

describe("settings", () => {
  it("forgets an account that was removed, with the posts found in it", async () => {
    const first = await pass(watching());
    expect(first.state.posts[idOf(older)]).toBeDefined();
    later();
    const without = await pass(withSettings(first.state, { accounts: [] }));
    expect(Object.keys(without.state.sources)).not.toContain("account:person:mila-novak");
    expect(without.state.posts).toEqual({});
  });
});

describe("checkAccount", () => {
  it("opens linkedin.com, says who is signed in, and leaves the page open", async () => {
    expect(await checkAccount({ browser: li, sleep: async () => undefined })).toEqual({ signedIn: true, handle: "dana-reyes", name: "Dana Reyes", slug: "dana-reyes" });
    expect(li.opened).toEqual([SIGN_IN_URL]);
    li.signedIn = false;
    expect(await checkAccount({ browser: li, sleep: async () => undefined })).toEqual({ signedIn: false });
    li.checkpoint = true;
    expect(await checkAccount({ browser: li, sleep: async () => undefined })).toEqual({ signedIn: false, securityCheck: true });
  });
});
