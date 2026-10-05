# Troubleshooting

Start with the log. In the app it is the monitor's log file (*Show log* in the panel); in the CLI, run with `--verbose`. Every `page` entry carries the URL asked for and the URL reached, whether LinkedIn drew posts, cards or comments (`rendered`, `units`), whether it said there is nothing (`empty`), what stood in front of them (`gate`), and how long it took; a page that drew nothing also carries a `diag` with its title, how many posts, cards and comments it held, the HTTP status, and the start of its text. Every `source` entry says how many items were read, where the line of already-seen posts was (`line`, `-1` for none), and how many were new.

## "The profile is not signed in to LinkedIn"

The page showed the sign-in wall: `/authwall`, `/login`, a sign-in form, or a page drawn for a visitor (sign-in links and no member photo in the nav). Everything the monitor reads needs a signed-in member. Open the profile, sign in to linkedin.com, and the next pass picks up from there; nothing seen before is announced again. The CLI exits with code 3 under `once`, and `run` waits three intervals before trying again.

LinkedIn ends sessions it distrusts — a new proxy country, a profile used from two places at once. If the profile keeps being signed out, give it a steady proxy in the account's usual country, and do not sign the same account in elsewhere at the same time.

## "LinkedIn stopped this account at a security check"

The page went to `/checkpoint/…` or said "Let's do a quick security check". LinkedIn wants a person to confirm the account — a code by email, a puzzle, a phone number. Open linkedin.com in the profile and complete it by hand. The monitor never tries; until it is done, every pass stops at the first page and waits three intervals before the next.

A check right after the first sign-in on a new proxy is common. Several in a row mean the account is read too often or from an address LinkedIn distrusts: raise the interval, lower `maxScrolls`, `maxSearches` and `maxCommentReads`, or use a steadier proxy.

## "LinkedIn is restricting this account"

The page said "You've reached the weekly limit", "temporarily restricted" or "unusual activity from your account", or answered with HTTP 999, the status LinkedIn gives traffic it takes for a bot. The note quotes LinkedIn's words. The monitor stops at once and waits three intervals. If it repeats:

- raise `--interval` (two hours is a sound start after a restriction);
- lower `--max-searches`, `--max-scrolls` and `--max-comment-reads`;
- watch fewer accounts;
- do not run other automation on the same account at the same time — including the reply agent in a tight loop.

A restriction on the account itself lasts as long as LinkedIn says it does, and may ask for an ID check; there is nothing to do but read it in the profile and wait.

## "LinkedIn's search limit is reached"

A search page said the "commercial use limit" is reached. LinkedIn caps how much a free account can search each month; the cap resets at the start of the next one, or with a paid plan. The monitor skips the searches, notes it, and reads the notifications, the accounts and the comments as usual; nothing is lost from those. To spend the searches that are left more slowly, lower `--max-searches` to 1, put fewer terms in it (your company names first), or turn search off (`--no-search`) and rely on notifications and watched accounts until the limit resets.

## "… was not found, or is not visible to this account"

The account's page said "This page doesn't exist" or "Profile not available". The link may be wrong (check that it opens in the profile), the person may have changed their public id, the company page may have been renamed, or the profile may be limited to the person's network. Fix the link, or remove the account.

## "… was read from the posts tab"

A person's recent-activity page drew nothing, so the pass read their posts tab (`/recent-activity/shares/`) instead. It works, but it holds only the person's own posts, not their reposts and shared comments. If it happens for one account once, it was a slow load; if it happens on every pass, look at the `page` and `posts_empty_read` log lines — LinkedIn may have changed the page in a way the scripts do not know yet. Open an issue with those lines.

## "LinkedIn drew no posts for … this pass"

Neither the activity page nor the posts tab drew a post, and neither said the account has none. The pass goes on with the other sources and keeps this one's state; the next pass tries again. If it lasts, open the account's activity in the profile: if posts show there, the page has changed — open an issue with the `page` and `source_failed` log lines (with names and texts removed).

## "LinkedIn drew no notifications this pass" / "drew no results for …"

The notifications page or a search page drew nothing and said nothing. Same as above: one pass is a slow load; every pass is a change on LinkedIn's side.

## "A post's page drew none of its new comments"

The post's count grew, but its page showed no comments: LinkedIn was slow, or collapsed them behind "Load more comments". The post stays due and is read again on the next pass. After three such reads in a row the monitor gives up on those comments and says so; open the post by hand if they matter.

## "The comments on a post could not be read"

Opening a post or reading its comments failed — the page was replaced while it was read, or the browser did not answer. The post keeps its count and is marked due, and the next pass opens it again. A post that is gone ("This post cannot be displayed") is dropped from the watch list instead.

## "linkedin.com could not be reached" / "The profile's browser could not open linkedin.com"

The tab showed Chromium's error page (the note carries its `ERR_` code), or the browser itself did not open the page. Check the profile's proxy and the network; the pass stops and the next one waits three intervals.

## "The read did not get back to posts seen before"

The source had more new posts than `maxScrolls` scrolls could reach, so the read never met a post the last pass saw. Every post the read did reach is still dated by its id, so nothing old is announced; posts below what was read may be missed. Raise `--max-scrolls` (up to 4), or shorten the interval within the pacing limits.

## "No company names or keywords"

With no terms, nothing is searched, and only the notifications and the watched accounts' posts are reported. Add your company's name (`--company`) and a few keywords.

## "Signed in, but LinkedIn did not say as whom"

The page drew no member photo with a name and no link to the member's profile. Posts are still read, but mentions of the account and its own posts are not recognized this pass. If it lasts, open linkedin.com in the profile and check that the nav shows the member's photo; a profile without a name on its photo needs one.

## A post I expected is missing

- It was there before the source's starting line: the first pass announces nothing.
- Its id says it was created before the starting line, or more than `maxItemAgeMs` ago — a plain repost is dated by the original post.
- It came from a search and names neither your company, nor a keyword, nor the account: LinkedIn's search found it, the local match did not.
- It names an exclusion word.
- It is the account's own post: those are not announced, only the comments on them.
- The read did not reach it within `maxScrolls`; the summary says so.
- The search it would be found by did not run: the search limit, `maxSearches`, or its term did not fit into the queries (the summary says how many terms are not searched).
- Its text was cut behind "…more" and the keyword is in the hidden part: the monitor never expands a post.
- It is in a group, an event or a newsletter: only notifications, the watched accounts' activity and LinkedIn's post search are read.

## A comment I expected is missing

- The post does not concern the account and is not a watched account's post: only those have their comments read.
- The post's drawn comment count did not grow and no new notification pointed at it, or the pass had opened `maxCommentReads` posts already; the summary says how many wait.
- LinkedIn's "Most relevant" selection on the post's page did not draw it.
- It was written before the starting line of the source that surfaced the post.
- It names nothing and is not addressed to the account.

## A notification I expected is missing

- It is a reaction, a view, a birthday, a job, a repost or a follow: there is nothing to answer.
- LinkedIn is set to a language other than English and the card names neither you, your company nor a keyword, and links no comment.
- It was there before the notifications' starting line.

## The same post or comment shows twice

It should not: a post is keyed by its id, a comment by its id (or, without one, by its post, author and text), and a post found by a notification and by a search in the same pass is one item. If it does, open an issue with both log lines.

## The profile does not start

`linkedin-monitor` starts the profile through nbc, which reports why a start failed:

| nbc says | Meaning |
| --- | --- |
| `ClawBrowser does not expose managed-proxy privacy capability 2` | The browser runtime is older than nbc needs for proxied profiles. Update it from the Nextbrowser app. |
| `SESSION_NOT_FOUND` | nbc is looking in the wrong runtime root. Point `--runtime-root` at the app's (`~/.nextbrowser/runtime` on macOS). |
| `API_KEY_REQUIRED`, `API_KEY_INVALID` | The Nextbrowser account setup is incomplete. Sign in to the app. |

## Reporting a problem

Open a [bug report](https://github.com/nextbrowser-oss/nextbrowser-linkedin-monitoring/issues/new/choose) with the version or commit and the relevant `--verbose` lines, with names, headlines and post text removed if they are private.
