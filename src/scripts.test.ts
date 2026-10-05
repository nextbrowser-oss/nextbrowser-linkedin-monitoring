// @vitest-environment happy-dom
/// <reference lib="dom" />
//
// The page scripts run here against trimmed documents shaped like what
// linkedin.com draws: the notifications page, a person's recent activity (a
// post with its comment preview, a plain repost), a company's posts, a search
// results page, a post's own page with comments and replies, and the screens
// in front of them — the authwall, a security check, the commercial use
// limit, a restriction, a profile that does not exist, and Chromium's error
// page. None has been captured from a live session yet: they follow the URNs,
// link shapes, aria labels and the few class names the scripts rely on, with
// everything else left out, and a live run is still owed.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMENT_SELECTOR,
  POSTS_READY_SELECTOR,
  allScripts,
  existsScript,
  identityScript,
  notificationsScript,
  pageHealthScript,
  postsScript,
  threadScript,
  type IdentitySnapshot,
  type NotificationsSnapshot,
  type PageHealth,
  type PostsSnapshot,
  type ThreadSnapshot,
} from "./scripts.js";

function run<T>(script: string): T {
  // Indirect eval: the script runs in the page's global scope, as it would in
  // Runtime.evaluate, and comes back through JSON as it would over CDP.
  return JSON.parse(JSON.stringify((0, eval)(script))) as T;
}

function page(url: string, html: string, title = ""): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
  document.title = title;
  document.body.innerHTML = html;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const POST = "urn:li:activity:7381234567890123456";
const REPOST = "urn:li:activity:7381000000000000002";

// The global nav a signed-in member gets: their photo, named.
const CHROME = `
  <header id="global-nav" class="global-nav"><nav>
    <a href="https://www.linkedin.com/feed/">Home</a>
    <div class="global-nav__me"><button><img class="global-nav__me-photo" alt="Dana Reyes" src="me.jpg"><span>Me</span></button></div>
  </nav></header>`;

/** An author block: the name and the headline for the eye, and again for a
 *  screen reader. */
function actor(name: string, href: string, headline: string, time: string): string {
  return `
    <div class="update-components-actor">
      <a class="update-components-actor__image" href="${href}?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAB"><img alt="View ${name}’s profile"></a>
      <a class="update-components-actor__meta-link" href="${href}?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACoAAB">
        <span class="update-components-actor__title"><span dir="ltr"><span aria-hidden="true">${name}</span><span class="visually-hidden">${name}</span></span><span class="update-components-actor__supplementary-actor-info"> • 2nd</span></span>
        <span class="update-components-actor__description"><span aria-hidden="true">${headline}</span><span class="visually-hidden">${headline}</span></span>
      </a>
      <span class="update-components-actor__sub-description"><span aria-hidden="true">${time} • Edited • </span><span class="visually-hidden">${time} ago • Edited • Visible to anyone</span></span>
    </div>`;
}

const ACTIVITY = `${CHROME}
  <main>
    <div class="scaffold-finite-scroll__content">
      <div class="feed-shared-update-v2" data-urn="${POST}">
        ${actor("Mila Novak", "https://www.linkedin.com/in/mila-novak", "Head of Operations at Northwind", "3h")}
        <div class="update-components-text"><span class="break-words"><span dir="ltr">We are looking for an alternative to Acme for invoicing.<br>Any suggestions? cc <a href="https://www.linkedin.com/in/dana-reyes">Dana Reyes</a> <a href="https://www.linkedin.com/feed/hashtag/?keywords=fintech">#fintech</a></span></span>
          <button class="see-more" aria-label="see more, visually reveals content which is already detected by screen readers"><span>…more</span></button></div>
        <div class="social-details-social-counts">
          <span class="social-details-social-counts__reactions-count">1,234</span>
          <button aria-label="23 comments on Mila Novak’s post"><span>23 comments</span></button>
          <button aria-label="4 reposts of Mila Novak’s post"><span>4 reposts</span></button>
        </div>
        <div class="feed-shared-social-action-bar"><button aria-label="React Like"><span>Like</span></button><button aria-label="Comment"><span>Comment</span></button></div>
        <div class="comments-comments-list">
          <article class="comments-comment-entity" data-id="urn:li:comment:(activity:7381234567890123456,7381240000000000009)">
            <a href="https://www.linkedin.com/in/bo-chen/">Bo Chen</a><span dir="ltr">Try Contoso, 3 comments in and I am sold</span>
          </article>
        </div>
      </div>
      <div class="feed-shared-update-v2" data-urn="${REPOST}">
        <div class="update-components-header"><a href="https://www.linkedin.com/in/mila-novak/">Mila Novak</a> reposted this</div>
        ${actor("Acme", "https://www.linkedin.com/company/acme/posts", "12,345 followers", "1w")}
        <div class="update-components-text"><span dir="ltr">Acme 4.0 is out</span></div>
        <div class="feed-shared-social-action-bar"><button aria-label="Comment"><span>Comment</span></button></div>
      </div>
    </div>
  </main>`;

const COMPANY = `${CHROME}
  <main>
    <h1>Acme</h1>
    <div class="feed-shared-update-v2" data-urn="urn:li:ugcPost:7381111111111111111">
      ${actor("Acme", "https://www.linkedin.com/company/acme/", "12,345 followers", "2d")}
      <div class="update-components-text"><span dir="ltr">We are #hiring a solutions engineer</span></div>
      <div class="social-details-social-counts"><button aria-label="Mila Novak and 41 others"><span>Mila Novak and 41 others</span></button></div>
      <div class="feed-shared-social-action-bar"><button aria-label="Comment"><span>Comment</span></button></div>
    </div>
  </main>`;

// A search result: LinkedIn wraps the post in a container that names it
// again (data-chameleon-result-urn).
const SEARCH = `${CHROME}
  <main><div class="search-results-container"><ul>
    <li class="reusable-search__result-container">
      <div data-chameleon-result-urn="urn:li:activity:7381300000000000001">
        <div class="feed-shared-update-v2" data-urn="urn:li:activity:7381300000000000001">
          ${actor("Ana Lima", "https://www.linkedin.com/in/ana-lima", "COO at Fabrikam", "45m")}
          <div class="update-components-text"><span dir="ltr">Who do you use for invoicing? <a href="https://www.linkedin.com/company/acme/">Acme</a> keeps timing out on us</span></div>
          <div class="feed-shared-social-action-bar"><button aria-label="Comment"><span>Comment</span></button></div>
        </div>
      </div>
    </li>
  </ul></div></main>`;

const NOTIFICATIONS = `${CHROME}
  <main><section>
    <article class="nt-card">
      <a href="https://www.linkedin.com/in/mila-novak/"><img alt="Mila Novak"></a>
      <div class="nt-card__headline"><a href="https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000001%29">
        <span class="nt-card__text--3-line"><strong>Mila Novak</strong> mentioned you in a comment: “Dana Reyes can you check the SSO setup?”</span></a></div>
      <span class="nt-card__time-ago">2h</span>
      <button aria-label="Settings menu"><span class="visually-hidden">Settings menu</span></button>
    </article>
    <article class="nt-card">
      <a href="https://www.linkedin.com/in/kim-ito/"><img alt="Kim Ito"></a>
      <div class="nt-card__headline"><a href="/feed/update/urn:li:activity:7381234567890123456/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000002%29&amp;replyUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000003%29">
        <span><strong>Kim Ito</strong> replied to your comment: “Did you keep SCIM on?”</span></a></div>
      <span class="nt-card__time-ago">5h</span>
    </article>
    <article class="nt-card">
      <a href="https://www.linkedin.com/in/bo-chen/"><img alt="Bo Chen"></a>
      <div class="nt-card__headline"><a href="https://www.linkedin.com/feed/update/urn:li:activity:7381999999999999999/"><span><strong>Bo Chen</strong> and 3 others commented on your post.</span></a></div>
      <span class="nt-card__time-ago">1d</span>
    </article>
    <article class="nt-card">
      <div class="nt-card__headline"><a href="https://www.linkedin.com/in/lee-park/"><span>Wish <strong>Lee Park</strong> a happy birthday</span></a></div>
      <span class="nt-card__time-ago">1d</span>
    </article>
  </section></main>`;

const THREAD = `${CHROME}
  <main>
    <div class="feed-shared-update-v2" data-urn="${POST}">
      ${actor("Dana Reyes", "https://www.linkedin.com/in/dana-reyes", "Community at Acme", "6h")}
      <div class="update-components-text"><span dir="ltr">We just shipped SSO for every Acme plan.</span></div>
      <div class="social-details-social-counts"><button aria-label="4 comments on Dana Reyes’s post"><span>4 comments</span></button></div>
      <div class="comments-comments-list">
        <article class="comments-comment-entity" data-id="urn:li:comment:(activity:7381234567890123456,7381240000000000001)">
          <div class="comments-comment-meta__actor">
            <a class="comments-comment-meta__image-link" href="https://www.linkedin.com/in/kim-ito?miniProfileUrn=x"><img alt="View Kim Ito’s profile"></a>
            <a class="comments-comment-meta__description-container" href="https://www.linkedin.com/in/kim-ito"><span class="comments-comment-meta__description-title">Kim Ito</span><span class="comments-comment-meta__description-subtitle">CTO at Contoso</span></a>
          </div>
          <time class="comments-comment-meta__data">1h</time>
          <div class="comments-comment-item__main-content"><span dir="ltr"><a href="https://www.linkedin.com/in/dana-reyes">Dana Reyes</a> does it work with Okta?</span></div>
          <button aria-label="Reply to Kim Ito’s comment"><span>Reply</span></button><span>2 replies</span>
          <div class="comments-replies-list">
            <article class="comments-comment-entity" data-id="urn:li:comment:(activity:7381234567890123456,7381240000000000002)">
              <div class="comments-comment-meta__actor"><a href="https://www.linkedin.com/in/dana-reyes"><span class="comments-comment-meta__description-title">Dana Reyes</span></a></div>
              <time>45m</time>
              <div class="comments-comment-item__main-content"><span dir="ltr">Yes, Okta and Azure AD.</span></div>
            </article>
          </div>
        </article>
        <article class="comments-comment-entity" data-id="urn:li:comment:(activity:7381234567890123456,7381240000000000004)">
          <div class="comments-comment-meta__actor"><a href="https://www.linkedin.com/company/fabrikam/"><span class="comments-comment-meta__description-title">Fabrikam</span><span class="comments-comment-meta__description-subtitle">2,000 followers</span></a></div>
          <time>now</time>
          <div class="comments-comment-item__main-content"><span dir="ltr">We switched from Acme last year</span></div>
        </article>
      </div>
    </div>
  </main>`;

describe("every script", () => {
  it.each(Object.entries(allScripts()))("%s is a single valid expression", (_name, script) => {
    expect(() => new Function(`return ${script};`)).not.toThrow();
  });
});

describe("postsScript", () => {
  it("reads a person's activity: author, headline, text, time, tags and counts, outside the comment preview", () => {
    page("https://www.linkedin.com/in/mila-novak/recent-activity/all/", ACTIVITY, "Activity | Mila Novak | LinkedIn");
    const snapshot = run<PostsSnapshot>(postsScript());
    expect(snapshot.gate).toEqual({ login_wall: false, checkpoint: false, restricted: "", search_limit: "", unavailable: false, network_error: "" });
    expect(snapshot.name).toBe("Mila Novak");
    expect(snapshot.posts).toHaveLength(2);
    expect(snapshot.posts[0]).toEqual({
      urn: POST,
      author: "Mila Novak",
      author_kind: "person",
      author_slug: "mila-novak",
      author_url: "https://www.linkedin.com/in/mila-novak/",
      author_headline: "Head of Operations at Northwind",
      text: "We are looking for an alternative to Acme for invoicing.\nAny suggestions? cc Dana Reyes #fintech",
      truncated: true,
      time_text: "3h",
      mentions: [{ name: "Dana Reyes", kind: "person", slug: "dana-reyes", url: "https://www.linkedin.com/in/dana-reyes/" }],
      comments_text: "23 comments on Mila Novak’s post",
      reactions_text: "1,234",
      reposts_text: "4 reposts of Mila Novak’s post",
      action_bar: true,
      reshare: false,
      reshared_by: "",
    });
  });

  it("reads a plain repost as the original author's post, reposted by the account", () => {
    page("https://www.linkedin.com/in/mila-novak/recent-activity/all/", ACTIVITY);
    const repost = run<PostsSnapshot>(postsScript()).posts[1];
    expect(repost).toMatchObject({
      urn: REPOST,
      author: "Acme",
      author_kind: "company",
      author_slug: "acme",
      author_url: "https://www.linkedin.com/company/acme/",
      author_headline: "12,345 followers",
      text: "Acme 4.0 is out",
      time_text: "1w",
      comments_text: "",
      reshare: true,
      reshared_by: "Mila Novak",
    });
  });

  it("reads a company's posts page, ugcPost URNs and named reactions included", () => {
    page("https://www.linkedin.com/company/acme/posts/?feedView=all", COMPANY, "Acme: Posts | LinkedIn");
    const snapshot = run<PostsSnapshot>(postsScript());
    expect(snapshot.name).toBe("Acme");
    expect(snapshot.posts).toEqual([
      expect.objectContaining({
        urn: "urn:li:ugcPost:7381111111111111111",
        author: "Acme",
        author_kind: "company",
        text: "We are #hiring a solutions engineer",
        time_text: "2d",
        reactions_text: "Mila Novak and 41 others",
        truncated: false,
        action_bar: true,
      }),
    ]);
  });

  it("reads a search result through the container LinkedIn wraps it in", () => {
    page("https://www.linkedin.com/search/results/content/?keywords=Acme%20OR%20invoicing&sortBy=%22date_posted%22", SEARCH);
    const snapshot = run<PostsSnapshot>(postsScript());
    expect(snapshot.posts).toEqual([
      expect.objectContaining({
        urn: "urn:li:activity:7381300000000000001",
        author: "Ana Lima",
        author_headline: "COO at Fabrikam",
        text: "Who do you use for invoicing? Acme keeps timing out on us",
        time_text: "45m",
        mentions: [{ name: "Acme", kind: "company", slug: "acme", url: "https://www.linkedin.com/company/acme/" }],
      }),
    ]);
  });

  it("says an empty search is empty, and a page that drew nothing is not", () => {
    page("https://www.linkedin.com/search/results/content/?keywords=zzz", `${CHROME}<main><h2>No results found</h2><p>Try shortening or rephrasing your search.</p></main>`);
    expect(run<PostsSnapshot>(postsScript())).toMatchObject({ empty: true, posts: [] });
    page("https://www.linkedin.com/in/mila-novak/recent-activity/all/", `${CHROME}<main><div class="scaffold-finite-scroll__content"></div></main>`);
    const blank = run<PostsSnapshot>(postsScript());
    expect(blank).toMatchObject({ empty: false, posts: [] });
    expect(blank.diag?.posts).toBe(0);
  });
});

describe("notificationsScript", () => {
  it("reads each card's words, actor, time and the post, comment and reply it links", () => {
    page("https://www.linkedin.com/notifications/?filter=all", NOTIFICATIONS);
    const snapshot = run<NotificationsSnapshot>(notificationsScript());
    expect(snapshot.cards).toHaveLength(4);
    expect(snapshot.cards[0]).toEqual({
      headline: "Mila Novak mentioned you in a comment: “Dana Reyes can you check the SSO setup?”",
      snippet: "Dana Reyes can you check the SSO setup?",
      actor: "Mila Novak",
      actor_kind: "person",
      actor_url: "https://www.linkedin.com/in/mila-novak/",
      post_urn: POST,
      comment_urn: "urn:li:comment:(activity:7381234567890123456,7381240000000000001)",
      reply_urn: "",
      time_text: "2h",
      link: "https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7381234567890123456%2C7381240000000000001%29",
    });
    expect(snapshot.cards[1]).toMatchObject({
      actor: "Kim Ito",
      snippet: "Did you keep SCIM on?",
      comment_urn: "urn:li:comment:(activity:7381234567890123456,7381240000000000002)",
      reply_urn: "urn:li:comment:(activity:7381234567890123456,7381240000000000003)",
      time_text: "5h",
    });
    expect(snapshot.cards[2]).toMatchObject({ headline: "Bo Chen and 3 others commented on your post.", post_urn: "urn:li:activity:7381999999999999999", comment_urn: "", time_text: "1d" });
    expect(snapshot.cards[3]).toMatchObject({ post_urn: "", actor: "Lee Park", link: "https://www.linkedin.com/in/lee-park/" });
  });
});

describe("threadScript", () => {
  it("reads the post, its comments and their replies, each with its URN, author and parent", () => {
    page(`https://www.linkedin.com/feed/update/${POST}/`, THREAD);
    const snapshot = run<ThreadSnapshot>(threadScript());
    expect(snapshot.post).toMatchObject({ urn: POST, author: "Dana Reyes", text: "We just shipped SSO for every Acme plan." });
    expect(snapshot.comments_text).toBe("4 comments on Dana Reyes’s post");
    expect(snapshot.comments).toEqual([
      {
        urn: "urn:li:comment:(activity:7381234567890123456,7381240000000000001)",
        parent_urn: "",
        author: "Kim Ito",
        author_kind: "person",
        author_url: "https://www.linkedin.com/in/kim-ito/",
        author_headline: "CTO at Contoso",
        text: "Dana Reyes does it work with Okta?",
        time_text: "1h",
        mentions: [{ name: "Dana Reyes", kind: "person", slug: "dana-reyes", url: "https://www.linkedin.com/in/dana-reyes/" }],
        replies_text: "2 replies",
      },
      expect.objectContaining({
        urn: "urn:li:comment:(activity:7381234567890123456,7381240000000000002)",
        parent_urn: "urn:li:comment:(activity:7381234567890123456,7381240000000000001)",
        author: "Dana Reyes",
        text: "Yes, Okta and Azure AD.",
        time_text: "45m",
      }),
      expect.objectContaining({
        urn: "urn:li:comment:(activity:7381234567890123456,7381240000000000004)",
        author: "Fabrikam",
        author_kind: "company",
        author_headline: "2,000 followers",
        text: "We switched from Acme last year",
        time_text: "now",
      }),
    ]);
  });
});

describe("identityScript", () => {
  it("takes the name from the member's photo and the public id from the feed's identity card", () => {
    page("https://www.linkedin.com/feed/", `${CHROME}<aside class="feed-identity-module"><a href="https://www.linkedin.com/in/dana-reyes/"><div>Dana Reyes</div></a></aside>`);
    expect(run<IdentitySnapshot>(identityScript())).toMatchObject({ name: "Dana Reyes", slug: "dana-reyes", chrome: true, gate: { login_wall: false } });
  });

  it("reports a signed-out page signed out", () => {
    page("https://www.linkedin.com/login?session_redirect=%2Ffeed%2F", `<form class="login__form" action="/checkpoint/lg/login-submit"><input name="session_key"><input name="session_password" type="password"></form>`);
    expect(run<IdentitySnapshot>(identityScript())).toMatchObject({ name: "", slug: "", chrome: false, gate: { login_wall: true } });
  });
});

describe("the screens in front of a page", () => {
  const health = () => run<PageHealth>(pageHealthScript());

  it("calls a drawn page rendered", () => {
    page("https://www.linkedin.com/in/mila-novak/recent-activity/all/", ACTIVITY);
    expect(health()).toMatchObject({ rendered: true, empty: false, gate: { login_wall: false, restricted: "" } });
    expect(health().units).toBeGreaterThan(1);
  });

  it("knows the authwall, and a public page drawn for a visitor", () => {
    page("https://www.linkedin.com/authwall?trk=bf&originalReferer=&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fmila-novak%2Frecent-activity%2Fall%2F", `
      <main><h1>Join LinkedIn</h1><form class="join-form"><input name="email-address"></form><a href="https://www.linkedin.com/login">Sign in</a></main>`);
    expect(health().gate).toMatchObject({ login_wall: true, checkpoint: false });
    page("https://www.linkedin.com/company/acme/posts/?feedView=all", `<header><a class="nav__button-secondary" href="https://www.linkedin.com/login?fromSignIn=true">Sign in</a></header>${COMPANY.replace(CHROME, "")}`);
    expect(health()).toMatchObject({ rendered: true, gate: { login_wall: true } });
  });

  it("knows a security check, and keeps LinkedIn's sign-in pages under /checkpoint/lg/ a sign-in", () => {
    page("https://www.linkedin.com/checkpoint/challenge/AgHmZ3x?ut=1", `<main><h1>Let’s do a quick security check</h1><form><input name="pin"></form></main>`);
    expect(health().gate).toMatchObject({ checkpoint: true, login_wall: false });
    page("https://www.linkedin.com/checkpoint/lg/sign-in-another-account", `<main><form action="/checkpoint/lg/login-submit"><input name="session_key"></form></main>`);
    expect(health().gate).toMatchObject({ checkpoint: false, login_wall: true });
  });

  it("knows the commercial use limit on search, and does not call it a restriction", () => {
    page("https://www.linkedin.com/search/results/content/?keywords=Acme", `${CHROME}<main><section><h2>You’ve reached the commercial use limit on search</h2>
      <p>Upgrade to Premium to keep searching.</p></section></main>`);
    expect(health().gate).toMatchObject({ search_limit: "reached the commercial use limit", restricted: "" });
  });

  it("knows a restriction from LinkedIn's own notice, not from what a post says", () => {
    page("https://www.linkedin.com/notifications/?filter=all", `${CHROME}<div role="dialog"><h2>Your account has been temporarily restricted</h2><p>We noticed unusual activity from your account.</p></div>`);
    expect(health().gate.restricted).toBe("Your account has been temporarily restricted");
    page("https://www.linkedin.com/in/mila-novak/recent-activity/all/", ACTIVITY.replace("We are looking for", "We saw unusual activity on your account, we are looking for"));
    expect(health().gate.restricted).toBe("");
  });

  it("treats HTTP 999 as a restriction", () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ responseStatus: 999 } as unknown as PerformanceEntry]);
    page("https://www.linkedin.com/in/mila-novak/recent-activity/all/", "<script></script>");
    expect(health().gate.restricted).toBe("HTTP 999");
  });

  it("knows a profile that does not exist", () => {
    page("https://www.linkedin.com/in/no-such-person/recent-activity/all/", `${CHROME}<main><h1>This page doesn’t exist</h1><p>Please check your URL or return to LinkedIn home.</p></main>`);
    expect(health()).toMatchObject({ rendered: false, gate: { unavailable: true, login_wall: false } });
  });

  it("knows Chromium's error page", () => {
    page("chrome-error://chromewebdata/", `<div id="main-message"><h1>This site can’t be reached</h1><div class="error-code">DNS_PROBE_FINISHED_NXDOMAIN ERR_NAME_NOT_RESOLVED</div></div>`);
    expect(health().gate).toMatchObject({ network_error: "ERR_NAME_NOT_RESOLVED", login_wall: false, unavailable: false });
  });

  it("ends a wait on a gate, on LinkedIn saying there is nothing, and on a post", () => {
    page("https://www.linkedin.com/in/mila-novak/recent-activity/all/", `${CHROME}<main></main>`);
    expect(run<{ found: boolean }>(existsScript(POSTS_READY_SELECTOR)).found).toBe(false);
    page("https://www.linkedin.com/checkpoint/challenge/1", "<div></div>");
    expect(run<{ found: boolean }>(existsScript(POSTS_READY_SELECTOR)).found).toBe(true);
    page("https://www.linkedin.com/in/quiet/recent-activity/all/", `${CHROME}<main><p>Quiet Person hasn’t posted lately</p></main>`);
    expect(run<{ found: boolean }>(existsScript(POSTS_READY_SELECTOR)).found).toBe(true);
    page(`https://www.linkedin.com/feed/update/${POST}/`, THREAD);
    expect(run<{ found: boolean }>(existsScript(COMMENT_SELECTOR)).found).toBe(true);
  });
});
