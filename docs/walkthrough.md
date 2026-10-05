# Walkthrough: from a LinkedIn post to an approved reply

This walkthrough follows one post through the four steps of the monitoring workflow — detect, triage, draft, approve — first in the Nextbrowser app, then with the standalone CLI. The account, the companies, the posts and the people are sample data; the CLI lines are what the CLI's own formatters print.

The example: **Acme** makes invoicing software for mid-size companies. Dana Reyes runs Acme's community and customer marketing, and LinkedIn is where Acme's buyers talk: finance leads asking their network which tool to pick, customers posting when something breaks. Dana wants to hear about every post that names Acme, every request for an invoicing tool, everything her biggest customer's head of operations (**Mila Novak**) posts, everything Acme's competitor **Northwind** announces, and every mention, comment and reply addressed to her.

## 1. Set up

**In Nextbrowser:**

1. Open **Skills → LinkedIn** and switch to **Monitoring**.
2. Choose the browser profile Dana uses for LinkedIn and press **Open linkedin.com**. Sign in as Dana in the window that opens. The panel now reads `Dana Reyes · Signed in`.
3. Under **What to watch**:
   - **Your company:** `Acme`
   - **Keywords:** `invoicing`, `accounts payable`
   - **Skip:** `hiring`
   - **Accounts:** `https://www.linkedin.com/in/mila-novak/`, `https://www.linkedin.com/company/northwind/`
4. Leave **Notifications**, **Comments** and **Search** on.
5. Leave the dial at 60 minutes and press **Start**.

**With the CLI** (same settings, saved in the state file for later runs):

```bash
node dist/node/bin.js run --profile acme \
  --company Acme --keywords "invoicing, accounts payable" --exclude hiring \
  --accounts https://www.linkedin.com/in/mila-novak/,https://www.linkedin.com/company/northwind/ \
  --interval 60m
```

## 2. The first pass draws the starting line

The first pass opens Dana's notifications, Mila's recent activity, Northwind's posts, and one search — `Acme OR invoicing OR "accounts payable"`, newest first — and announces nothing: what is already there is the starting line, and a monitor that greets you with last week's posts is noise, not news. It remembers every post and card it read by id, and the comment count of each post that concerns Dana, so from now on it opens a post only when that count grows or a new notification points at it.

```text
09:00  signed in as Dana Reyes
09:00  pass Dana Reyes: starting line: 4 sources, 7 matches
```

In the app, *Needs a look* already lists the 7 matches it found within the last 72 hours — none of them marked *New*.

## 3. Detect: a customer complains, a lead asks, people talk to Dana

Between 09:00 and 10:00:

- Mila Novak posts: *"Dana Reyes, is SSO with Okta on the roadmap for this quarter?"*, tagging Dana.
- Lee Park, a controller at another company, posts: *"Acme had an outage this morning, anyone else seeing failed syncs?"*
- Kim Ito comments on Dana's own post from yesterday about SSO: *"Does it work with Okta groups, or only single users?"*
- Ana Lima posts: *"Looking for recommendations on an invoicing tool for a 20-person agency"*.
- Northwind announces: *"Northwind Pay is now live in 12 new countries"*.

The 10:00 pass finds all five:

- **Mila's post** arrives as a notification ("Mila Novak mentioned you in a post"). The card says little, so the pass opens the post, which gives the alert its text and its author.
- **Kim's comment** arrives as a notification that links the comment itself (`?commentUrn=`). The pass opens Dana's post too, to catch any other comments the card did not show.
- **Lee's and Ana's posts** come from the search. LinkedIn's search is fuzzy, so each result is matched again: Lee's names `Acme`, Ana's names `invoicing`.
- **Northwind's post** comes from Northwind's posts page: every new post of a watched account is reported.

Each one is new because its id says it was created after the starting line — a LinkedIn id carries the moment it was made — and it was never seen before.

## 4. Triage: most urgent first, with the reasons

```text
10:00  HIGH    Mila Novak mentioned you in a post: Dana Reyes, is SSO with Okta on the roadmap for this quarter?
        [Mentions you · Asks a question]  https://www.linkedin.com/feed/update/urn:li:activity:7512807092256769234/
10:00  HIGH    Lee Park mentioned Acme: Acme had an outage this morning, anyone else seeing failed syncs?
        [Mentions your company · Says "outage" · Asks a question]  https://www.linkedin.com/feed/update/urn:li:activity:7512809084551169234/
10:00  MEDIUM  Kim Ito commented on your post: Does it work with Okta groups, or only single users?
        [Comments on your post · Asks a question]  https://www.linkedin.com/feed/update/urn:li:activity:7512527491563521234/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7512527491563521234%2C7512811991203841234%29
10:00  MEDIUM  Ana Lima posted (search): Looking for recommendations on an invoicing tool for a 20-person agency
        [Asks for a recommendation · No comments yet]  https://www.linkedin.com/feed/update/urn:li:activity:7512804462428161234/
10:00  low     Northwind posted: Northwind Pay is now live in 12 new countries
        https://www.linkedin.com/feed/update/urn:li:activity:7512800125517825234/
10:00  pass Dana Reyes: 4 sources: 5 new (2 urgent) of 12 matches; 2 threads read
```

Why each one landed where it did ([the rules](how-it-works.md#triage)):

| Match | Points | Level |
| --- | --- | --- |
| Lee: names your company (+3), says "outage" (+3, it names your company), asks a question (+1) | 7 | high |
| Mila: mentions you (+4), asks a question (+1) | 5 | high |
| Kim: comments on your post (+2), asks a question (+1) | 3 | medium |
| Ana: asks for a recommendation (+2), nobody has commented yet (+1) — a lead, not an emergency | 3 | medium |
| Northwind: a competitor's news, nothing to answer | 0 | low |

Every line links straight to the post or the comment. In the app, every match also shows its author's headline ("Controller at Fabrikam") and the post it belongs to — Kim's comment shows Dana's post *"We just shipped SSO for every Acme plan."* — so it can be judged without opening LinkedIn.

## 5. Draft: hand a match to the reply agent

Lee's post is the one to answer first: a public complaint about an outage, on a post nobody from Acme has answered. In the app, press **Draft reply** on it. The connected agent (Claude Code or Codex) receives one task, with the match's author and post: open this post in the same browser profile, read it and its comments, and write one comment that answers it in Dana's voice. It shows the draft in the chat:

> **Draft for Lee Park** (post found by search, mentions Acme):
> "Hi Lee, Dana from Acme here. Sorry about this morning: syncs to NetSuite failed between 07:40 and 08:55 UTC and have been retried since. If any of yours still show as failed, send me a message and I'll have our support team look right away."
>
> Post this comment?

Nothing has been posted yet.

## 6. Approve, and only then publish

Answer **yes** and the agent posts that comment under Lee's post and reports whether LinkedIn showed it. Answer with changes and it redrafts. Answer **no** and nothing happens. Back in the panel, mark the match **Done** so it leaves *Needs a look*.

Ana's request is a lead: Dana may prefer to answer it herself, or not at all. The monitor ranks it and stops; whether Acme replies to a stranger asking for recommendations is a person's call.

The engine never posts, reacts, comments, connects or messages — it does not even press "…more". Publishing exists only in the reply agent, and only after an explicit approval.

## 7. When something goes wrong

Monitoring keeps saying what it could not do instead of going quiet. When a person's activity page draws nothing — it is lazy, and sometimes stays blank — the pass reads their posts tab instead:

```text
11:00  pass Dana Reyes: 4 sources: 0 new of 11 matches; 1 via the posts tab
        Mila Novak was read from the posts tab: the activity page drew nothing.
```

When LinkedIn's search limit for free accounts is reached, the searches are skipped and everything else is read:

```text
12:00  pass Dana Reyes: 4 sources: 0 new of 10 matches; search limit reached; 1 thread read
        LinkedIn's search limit is reached ("reached the commercial use limit"): searches are skipped this pass; notifications, accounts and comments are read as usual.
```

When LinkedIn restricts the account, the pass stops at once, and the next one waits three intervals:

```text
13:00  pass Dana Reyes: 1 source: 0 new of 3 matches; restricted
        LinkedIn is restricting this account ("You’ve reached the weekly limit"). The pass stopped; the next one waits three intervals.
```

A security check stops the pass the same way and needs a person:

```text
16:00  security check for Dana Reyes: open linkedin.com in the profile and complete it
16:00  pass Dana Reyes: security check
        LinkedIn stopped this account at a security check. Open linkedin.com in the profile and complete it; monitoring picks up on the next pass.
```

Open linkedin.com in the profile, complete it by hand, and monitoring continues from where it stopped — nothing it saw before is announced again, and nothing that arrived in between is lost while it is inside the 72-hour window and the scroll limit. [Troubleshooting](troubleshooting.md) covers every such state.
