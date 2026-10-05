import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassSummary } from "../engine.js";
import type { LinkedInItem } from "../items.js";
import { emptyState } from "../state.js";
import { describeEvent, describePass, parseDuration, settingsFromFlags } from "./cli.js";
import { defaultStatePath, loadState, saveState } from "./store.js";

describe("parseDuration", () => {
  it("reads the durations the flags take", () => {
    expect(parseDuration("60m", "--x")).toBe(3_600_000);
    expect(parseDuration("72h", "--x")).toBe(259_200_000);
    expect(() => parseDuration("soon", "--interval")).toThrow("--interval");
  });
});

describe("settingsFromFlags", () => {
  it("patches only what was given, and the negative flag wins", () => {
    expect(settingsFromFlags({})).toEqual({});
    expect(settingsFromFlags({ "no-comments": true, comments: true, "no-search": true, notifications: true, "keep-tab": true })).toEqual({
      watchComments: false, searchKeywords: false, watchNotifications: true, parkTab: false,
    });
    expect(settingsFromFlags({
      accounts: "https://www.linkedin.com/in/mila-novak/, company/acme",
      company: "Acme, Acme Inc",
      keywords: "invoicing, accounts payable",
      "max-comment-reads": "3",
      "max-searches": "1",
    })).toEqual({
      accounts: [{ kind: "person", slug: "mila-novak" }, { kind: "company", slug: "acme" }],
      companyNames: ["Acme", "Acme Inc"],
      keywords: ["invoicing", "accounts payable"],
      maxCommentReads: 3,
      maxSearches: 1,
    });
  });

  it("refuses something that is not an account", () => {
    expect(() => settingsFromFlags({ accounts: "in/mila-novak, https://www.linkedin.com/feed/" })).toThrow("not a LinkedIn profile or company");
  });
});

const post = { id: "7381234567890123456", urn: "urn:li:activity:7381234567890123456", url: "https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/", author: "Lee Park", text: "Rolling out SSO" };

function item(patch: Partial<LinkedInItem>): LinkedInItem {
  return { key: `post:${post.id}`, id: post.id, kind: "post", author: "Lee Park", text: "Who do you use for invoicing?", url: post.url, post, ...patch };
}

describe("describeEvent", () => {
  const at = new Date(2026, 9, 5, 9, 5).getTime();
  const triage = { urgency: "medium" as const, score: 3, reasons: ["Asks for a recommendation", "Asks a question"] };

  it("writes a match on two lines: who and how urgent, then why and the link", () => {
    const line = describeEvent({ type: "new_item", at, source: { kind: "search", name: "Acme OR invoicing", query: "Acme OR invoicing" }, keywords: ["invoicing"], triage, item: item({}) });
    expect(line).toBe(`09:05  MEDIUM  Lee Park posted (search): Who do you use for invoicing?\n        [Asks for a recommendation · Asks a question]  ${post.url}`);
  });

  it("says how an item concerns you", () => {
    const say = (patch: Partial<LinkedInItem>, kind: "notifications" | "account" | "comments" = "notifications") =>
      describeEvent({ type: "new_item", at, source: { kind, name: "x" }, keywords: [], triage: { urgency: "low", score: 0, reasons: [] }, item: item(patch) }).split("\n")[0];
    expect(say({ addressed: "mention" })).toContain("Lee Park mentioned you in a post: ");
    expect(say({ company: "Acme" })).toContain("Lee Park mentioned Acme: ");
    expect(say({ reshare: true, resharedBy: "Mila Novak" }, "account")).toContain("Mila Novak reposted Lee Park's post: ");
    expect(say({ kind: "comment", author: "Kim Ito", addressed: "reply" })).toContain("Kim Ito replied to your comment: ");
    expect(say({ kind: "comment", author: "Kim Ito", addressed: "comment_on_post" })).toContain("Kim Ito commented on your post: ");
    expect(say({ kind: "comment", author: "Kim Ito", company: "Acme" }, "comments")).toContain("Kim Ito mentioned Acme on Lee Park's post: ");
    expect(say({ kind: "comment", author: "Kim Ito" }, "comments")).toContain("Kim Ito commented on Lee Park's post: ");
    expect(describeEvent({ type: "security_check", at, handle: "dana-reyes" })).toContain("open linkedin.com in the profile");
  });
});

describe("describePass", () => {
  const summary: PassSummary = {
    signedIn: true, handle: "Dana Reyes", loginRequired: false, securityCheck: false, rateLimited: false, searchLimited: false,
    pagesLoaded: 7, sourcesRead: 4, baselines: 0, fallbacks: 1, unreadable: 0, searches: 1, itemsRead: 40, scrolls: 2,
    matches: 6, newItems: 2, urgent: 1, commentReads: 2, commentReadsDeferred: 0, stopped: false, notes: [],
  };

  it("sums a pass up in one line", () => {
    expect(describePass(summary, new Date(2026, 9, 5, 21, 5).getTime()))
      .toBe("21:05  pass Dana Reyes: 4 sources: 2 new (1 urgent) of 6 matches; 1 via the posts tab; 2 threads read");
  });

  it("says what stopped it", () => {
    const line = describePass({ ...summary, sourcesRead: 0, fallbacks: 0, commentReads: 0, rateLimited: true, notes: ["Wait it out."] }, new Date(2026, 9, 5, 9, 0).getTime());
    expect(line).toBe("09:00  pass Dana Reyes: restricted\n        Wait it out.");
    expect(describePass({ ...summary, searchLimited: true }, 0)).toContain("search limit reached");
  });
});

describe("the state file", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("lives under ~/.nextbrowser/linkedin-monitoring, one file per profile", () => {
    expect(defaultStatePath("acme team")).toMatch(/\.nextbrowser[/\\]linkedin-monitoring[/\\]acme_team\.json$/);
  });

  it("round-trips, and refuses a file it cannot read", async () => {
    dir = await mkdtemp(join(tmpdir(), "linkedin-monitor-"));
    const path = join(dir, "nested", "state.json");
    expect(await loadState(path)).toEqual(emptyState());
    const state = { ...emptyState({ accounts: ["in/mila-novak"] }), seen: ["post:1"] };
    await saveState(path, state);
    expect(await loadState(path)).toEqual(state);
    await writeFile(path, "{ not json");
    await expect(loadState(path)).rejects.toThrow();
  });
});
