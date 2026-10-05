# Events and state

## Events

Every event is a plain JSON object with a `type` and an `at` (the pass time, epoch milliseconds). A pass returns its events in `result.events`; with `onEvent` it also hands each one over as it happens.

### `new_item`

Something new that needs a look: a mention, a reply to the account's comment, a comment on the account's post, a watched account's new post, a post or a comment that names your company or a keyword.

```json
{
  "type": "new_item",
  "at": 1791194400000,
  "account": "Dana Reyes",
  "source": { "kind": "notifications", "name": "notifications" },
  "keywords": [],
  "triage": { "urgency": "medium", "score": 3, "reasons": ["Comments on your post", "Asks a question"] },
  "item": {
    "key": "comment:7512811991203841234",
    "id": "7512811991203841234",
    "kind": "comment",
    "author": "Kim Ito",
    "authorKind": "person",
    "authorHeadline": "IT Director at Contoso",
    "authorUrl": "https://www.linkedin.com/in/kim-ito/",
    "text": "Does it work with Okta groups, or only single users?",
    "url": "https://www.linkedin.com/feed/update/urn:li:activity:7512527491563521234/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7512527491563521234%2C7512811991203841234%29",
    "post": {
      "id": "7512527491563521234",
      "urn": "urn:li:activity:7512527491563521234",
      "url": "https://www.linkedin.com/feed/update/urn:li:activity:7512527491563521234/",
      "author": "Dana Reyes",
      "authorUrl": "https://www.linkedin.com/in/dana-reyes/",
      "text": "We just shipped SSO for every Acme plan."
    },
    "createdAt": 1791193960000,
    "timeText": "7m",
    "addressed": "comment_on_post"
  }
}
```

| Field | Meaning |
| --- | --- |
| `account` | The signed-in member's name, or public id. |
| `source.kind` | `notifications`, `account` (a watched person or company; `source.account` is `{kind, slug}`), `search` (`source.query` is the query), or `comments` (on a post one of the others surfaced). `source.name` is a readable name: "notifications", the account's name, the query, or for comments the name of the source that surfaced the post. |
| `keywords` | The keywords the item names. Your company names are in `item.company`. |
| `triage` | `urgency` (`high`, `medium`, `low`), `score`, and `reasons`, strongest first. |
| `item.key` | `post:<id>` or `comment:<id>`: the same on every read, from every source. A comment drawn without an id is keyed `comment:<post>:<hash of author and text>`. |
| `item.kind` | `post` or `comment` (a reply is a comment with a `parent`). |
| `item.author`, `authorKind`, `authorHeadline`, `authorUrl` | Who wrote it: the name as drawn, `person` or `company`, the line LinkedIn draws under the name, and the profile or company link. |
| `item.text` | The text, up to 2,000 characters. `item.truncated` is `true` when LinkedIn cut it behind "…more". For a notification whose post or comment was not opened, the card's own words. |
| `item.url` | A direct link: the post (`/feed/update/<urn>/`) or the comment (the post's link with `?commentUrn=`, and `&replyUrn=` for a reply). |
| `item.post` | The post itself, or the post a comment is on: `id`, `urn`, `url`, `author`, `authorUrl`, and the opening of its text (200 characters). A notification's post has no text unless the pass opened it. |
| `item.parent` | For a reply: the comment it answers (`id`, `author`, `text`). |
| `item.createdAt` | When it was created: from its id, or the earliest time the drawn label allows when it has no id. |
| `item.timeText` | The time as LinkedIn drew it. |
| `item.reactions`, `item.replies`, `item.reposts` | A post's reaction, comment and repost counts as drawn; for a comment, `replies` is its reply count. |
| `item.reshare`, `item.resharedBy` | A repost, and for a plain repost who reposted it (the author is the original poster). |
| `item.addressed` | `mention`, `reply` or `comment_on_post`, when the item concerns the account. |
| `item.company` | Which of your company names it names. |

### `signed_in`, `signed_out`, `account_changed`, `security_check`

```json
{ "type": "signed_in", "at": 1791190800000, "handle": "Dana Reyes", "name": "Dana Reyes" }
{ "type": "signed_out", "at": 1791205200000, "handle": "Dana Reyes" }
{ "type": "account_changed", "at": 1791208800000, "previous": "Dana Reyes", "current": "Sam Ortiz" }
{ "type": "security_check", "at": 1791203400000, "handle": "Dana Reyes" }
```

- **`signed_in`** is emitted on the first pass, and on the first pass after a sign-out.
- **`signed_out`** is emitted once when the session ends. Nothing is read until someone signs the profile in again.
- **`account_changed`** is emitted when the page names a different member than before. The previous member's notifications start a new starting line, and their own posts stop being "your posts".
- **`security_check`** is emitted on every pass LinkedIn holds the account at a `/checkpoint/` page; complete it in the profile.

A restriction and the search limit have no event of their own: the summary carries them (`rateLimited`, `blocked`, `searchLimited`), since they end with time rather than with something the person does.

## The pass summary

| Field | Meaning |
| --- | --- |
| `signedIn`, `handle` | Whether a signed-in session was found, and the member's public id or name. |
| `loginRequired` | The profile is not signed in. |
| `securityCheck` | LinkedIn wants a security check. |
| `rateLimited` | LinkedIn is restricting the account (a weekly limit, "unusual activity", HTTP 999). |
| `blocked` | Why the pass stopped reading, when it did: a security check, a restriction, or linkedin.com not reachable. Back off. |
| `searchLimited` | LinkedIn's search limit was reached; the searches were skipped and the rest was read. |
| `pagesLoaded` | Pages opened on linkedin.com. |
| `sourcesRead`, `baselines` | Sources read (the notifications, each account, each search), and how many of them were read for the first time or with new terms. |
| `fallbacks` | Accounts read from the posts tab. |
| `unreadable` | Sources not read this pass: not found, or nothing drawn. |
| `searches` | Searches run. |
| `itemsRead`, `scrolls` | Posts and cards read across the sources, and scrolls made. |
| `matches` | Items that matched inside the age window, new or not. |
| `newItems`, `urgent` | New matches, and how many are *high*. |
| `commentReads`, `commentReadsDeferred` | Posts opened for their comments, and posts whose comments are due but wait for the next pass. |
| `stopped` | `shouldStop` ended the pass early. |
| `notes` | Up to six sentences a person can read. |

## The state document

```jsonc
{
  "version": 1,
  "settings": { /* see below */ },
  "account": { "handle": "Dana Reyes", "name": "Dana Reyes", "signedIn": true, "checkedAt": 1791194400000 },
  "sources": {
    "notifications": { "since": 1791190800000, "filter": "", "lastReadAt": 1791194400000, "lastNewAt": 1791194400000 },
    "account:person:mila-novak": { "since": 1791190800000, "filter": "all", "name": "Mila Novak", "lastReadAt": 1791194400000, "fallback": true },
    "account:company:northwind": { "since": 1791190800000, "filter": "all", "name": "Northwind", "lastReadAt": 1791194400000 },
    "search:acme or invoicing or \"accounts payable\"": { "since": 1791190800000, "filter": "accounts payable|acme|invoicing", "lastReadAt": 1791194400000 }
  },
  "seen": ["notification:1x9k2a", "post:7512809084551169234", "comment:7512811991203841234"],   // last 5,000 keys
  "posts": {
    "7512527491563521234": { "urn": "urn:li:activity:7512527491563521234", "source": "notifications", "own": true, "comments": 7, "threadReadAt": 1791194400000, "checkedAt": 1791194400000 },
    "7512809084551169234": { "urn": "urn:li:activity:7512809084551169234", "source": "search:acme or invoicing or \"accounts payable\"", "own": false, "comments": 3, "checkedAt": 1791194400000 },
    "7512806000000000000": { "urn": "urn:li:activity:7512806000000000000", "source": "account:person:mila-novak", "own": false, "comments": 12, "due": true, "checkedAt": 1791194400000 }
  },
  "lastPass": { "at": 1791194400000, "finishedAt": 1791194511000, "newItems": 5, "urgent": 2, "notes": [] }
}
```

- `sources[…].since` is a source's starting line: nothing created before it is announced. `filter` is what the source was read with — `all` for an account, the sorted term set for a search — and a change starts a new starting line. `name` is the account's name as drawn; `fallback` says the last read came from the posts tab; `note` says why the source could not be read on a later pass.
- `seen` holds every post, comment and notification-card key read, matched or not.
- `posts` is what makes comment reads cheap: for each watched post, where it was found, whether the account wrote it, its comment count when last read or first seen (absent when only a notification pointed at it), and `due` when a read is owed — a notification pointed at it, or a pass had opened its share. Up to 300 posts; a post found in a source that is no longer configured is dropped.
- `account.slug` is the member's public id, when a page linked it; `account.handle` is that or the name.

Pass anything read from storage through `normalizeState`.

## Settings

| Setting | Type | Default | Range and meaning |
| --- | --- | --- | --- |
| `accounts` | `{kind: "person" \| "company", slug: string}[]` | `[]` | Up to 10. Given as profile or company links (`https://www.linkedin.com/in/<slug>/`, `/company/<slug>/`, any country subdomain), `in/<slug>`, `company/<slug>`, `person:<slug>`, `company:<slug>`, a bare slug (a person), or `{kind, slug}`. |
| `companyNames` | `string[]` | `[]` | Up to 5 names of your own company, 2–60 characters. Always searched; an item that names one ranks high. |
| `keywords` | `string[]` | `[]` | Up to 20 words or phrases, 2–60 characters. |
| `excludeKeywords` | `string[]` | `[]` | Up to 20 words that drop an item even when a keyword matched, unless it is addressed to the account. |
| `urgentTerms` | `string[]` | a built-in list | Up to 50. `[]` turns the rule off. |
| `watchNotifications` | `boolean` | `true` | Read the notifications. |
| `watchComments` | `boolean` | `true` | Read the comments on posts that concern the account and on the watched accounts' posts, when due. |
| `searchKeywords` | `boolean` | `true` | Search LinkedIn's posts for the company names and keywords. |
| `maxSearches` | `number` | `2` | 0–3 searches per pass, up to six terms each. |
| `maxScrolls` | `number` | `2` | 0–4 scrolls per page. |
| `maxCommentReads` | `number` | `4` | 0–8 posts opened per pass. |
| `maxItemAgeMs` | `number` | 72 h | Older items are not announced. `0` turns the limit off. |
| `parkTab` | `boolean` | `true` | Leave the tab on `about:blank` after a pass. |

`scheduleDelay(intervalMs)` returns the interval with a ±20% spread, never under thirty minutes (sixty by default), and three times as long with `backOff`.
