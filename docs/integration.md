# Integration guide

The package has two entry points:

| Entry | Contents | Runs in |
| --- | --- | --- |
| `@nextbrowser-oss/linkedin-monitoring` | `runPass`, `checkAccount`, state and settings, events, keyword matching and search queries, `triage`, ids and links, drawn-time and count parsing, `scheduleDelay` | Anywhere. It has no Node imports; [`src/core.test.ts`](../src/core.test.ts) enforces this. |
| `@nextbrowser-oss/linkedin-monitoring/node` | `nbcBrowser` (a browser over the `nbc`/`nextctl` CLI), `loadState`/`saveState`, the CLI | Node.js 22 or later |

## Installing

The package is consumed from Git. `prepare` builds `dist/` on install:

```bash
npm install github:nextbrowser-oss/nextbrowser-linkedin-monitoring#<commit-or-tag>
```

Pin a commit or a tag rather than a branch, so a rebuild of the app never picks up an unreviewed change.

## The contract with Nextbrowser

The app owns everything that has a lifetime — the browser prepared for the selected profile, the timer, the storage. The engine owns only the logic of one pass.

```ts
import { normalizeState, runPass, scheduleDelay, withSettings } from "@nextbrowser-oss/linkedin-monitoring";
import { cliBrowser } from "./lib/xreply/browser";

async function monitorPass(profileArgs: string[]) {
  const saved = normalizeState(await readAppData("linkedin-monitor-state.json"));
  const { state, events, summary, matches } = await runPass({
    browser: cliBrowser(profileArgs),
    state: saved,
    log: (entry) => appendAppData("linkedin-monitor-log.jsonl", entry),
    onStep: (step) => setStatus(step),
    onEvent: (event) => showNotification(event),
    shouldStop: () => stopRequested,
  });
  await writeAppData("linkedin-monitor-state.json", state);
  showMatches(matches);
  const backOff = !!summary.blocked || summary.rateLimited || summary.securityCheck || summary.loginRequired;
  return scheduleDelay(60 * 60_000, { backOff });
}

// Settings changed in the UI: patch them, normalized. Profile and company
// links, "in/<slug>", "company/<slug>" and {kind, slug} are all accepted.
const next = withSettings(saved, {
  accounts: ["https://www.linkedin.com/in/mila-novak/", "company/northwind"],
  companyNames: ["Acme"],
  keywords: ["invoicing", "accounts payable"],
});
```

### What to show

`result.matches` holds every item the pass found that matched, new or not, inside the `maxItemAgeMs` window, most urgent first. A first pass announces nothing but still returns what it found, so a dashboard is never empty after Start. `result.events` holds what is new; a dashboard marks those.

Each match carries everything a person needs to judge it without opening LinkedIn, and a panel should show all of it:

- `item.author`, `item.authorHeadline`, `item.authorUrl`, `item.authorKind` — who wrote it and what they do ("Controller at Fabrikam"), which on LinkedIn is half the context;
- `item.post` — the post's `id`, `urn`, `url`, `author` and the opening of its text (for a post, the post itself; for a comment, the post it is on);
- `item.parent` — for a reply, the comment it answers (`id`, `author`, `text`);
- `item.url` — a direct link to the post or the comment;
- `item.addressed` — `mention`, `reply` or `comment_on_post`; `item.company` — which of your company names it names;
- `source` — `notifications`, `account` (with `source.account`), `search` (with `source.query`), or `comments` on a post one of those surfaced;
- `item.truncated` — LinkedIn cut the text behind "…more"; the rest is on the page;
- `item.createdAt` — when it was made, from its id; `item.timeText` — the time as LinkedIn drew it ("3h");
- `triage.reasons` — what makes a *high* believable.

`summary.loginRequired`, `summary.securityCheck`, `summary.rateLimited` and `summary.searchLimited` each need their own message in a panel: each asks the person for something different (sign in, complete a check, wait, accept that search is off until the limit resets). `summary.notes` names an account that was not found, read from its posts tab, or not drawn; show them beside the account.

### From a match to a reply

The engine never answers. In Nextbrowser, *Draft reply* hands a match to the LinkedIn skill's reply agent with one task: open `item.url` in the same profile, read the post and its comments, write one reply to that post or comment, show it, and post it only after the user approves. Pass `item.url`, `item.key`, `item.author`, `item.authorHeadline`, `item.post` and `item.parent` to that flow, so the draft is written with the post and the person in view.

### Showing the account before anything runs

`checkAccount` opens linkedin.com in the profile, reads who is signed in, and stops there, leaving the page open for a person who is about to sign in. It also reports a pending security check, a restriction, and a page that could not be reached.

```ts
import { checkAccount } from "@nextbrowser-oss/linkedin-monitoring";

const { signedIn, handle, name, slug, securityCheck, blocked } = await checkAccount({ browser: cliBrowser(profileArgs) });
```

`handle` is the member's public id when the feed linked it, their name otherwise.

### The browser

`MonitorBrowser` is a subset of the app's `XBrowser` (`src/lib/xreply/browser.ts`), so the app passes its existing `cliBrowser(profileArgs)`:

```ts
interface MonitorBrowser {
  open(url: string): Promise<void>;
  evaluate<T>(script: string, label?: string): Promise<T>;
  waitForLoad(timeoutSeconds?: number): Promise<void>;
}
```

### Sharing the profile

The monitor, the reply agent, and the user's own agent runs may drive the same profile. They must take turns: run the monitor pass in the queue the app already uses for its other engine passes. A pass opens several pages one after another with long pauses between them, so it holds the tab for a minute or two; `shouldStop` ends it between pages.

### State

The state is one JSON document. Store it as it is, and pass whatever comes back from storage through `normalizeState`, which accepts older files, hand edits, and nothing at all. The layout is in [events and state](events-and-state.md).

### Logging

`log` receives one JSON object per step: every page with what it showed and how long it took, every source with how many items it held, where the seen line was and how many were new, every post opened for comments, and every event. A page that drew nothing is logged with a short description of what was there (its title, how many posts, cards and comments, the HTTP status, the start of its text). Append it to a rotated file; when a read fails on a user's machine, it is the full record. It holds the text of what was read, so treat it as private.

## Outside the app: the Node adapter

```ts
import { runPass, withSettings } from "@nextbrowser-oss/linkedin-monitoring";
import { loadState, nbcBrowser, saveState } from "@nextbrowser-oss/linkedin-monitoring/node";

const browser = nbcBrowser({ profile: "my-linkedin-profile" });
await browser.start();
const path = "state.json";
const state = withSettings(await loadState(path), { companyNames: ["Acme"], keywords: ["invoicing"] });
const result = await runPass({ browser, state });
await saveState(path, result.state);
```

`nbcBrowser` runs `nbc --profile <name> <command> … --format json` and reads nbc's `{ok, data, error}` envelope, with the app's runtime root and environment by default, so it drives the profiles the app manages. Override the runtime root with `runtimeRoot` and the binary with `binary`.
