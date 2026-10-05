# CLI reference

`linkedin-monitor` runs the engine against one Nextbrowser profile from a terminal. It exists for developing the engine and for running it without the app. The profile must be signed in to linkedin.com.

```bash
npm ci && npm run build
node dist/node/bin.js <command> --profile <name> [options]
```

## Commands

| Command | What it does |
| --- | --- |
| `run` | Runs passes until stopped. Waits `--interval` between them, with a random spread. |
| `once` | Runs one pass and exits. |
| `state` | Prints the saved state as JSON. |

## What is watched

| Flag | Default | Meaning |
| --- | --- | --- |
| `--accounts a,b` | none | People and companies to watch, up to 10: profile or company links, `in/<slug>`, `company/<slug>`. Replaces the saved list. |
| `--company "a,b"` | none | Your company's names, up to 5: always searched, and a mention ranks high. |
| `--keywords "a,b c"` | none | Words and phrases, separated by commas: matched everywhere and searched. |
| `--exclude "a,b"` | none | Words that drop an item even when a keyword matched. |
| `--urgent-terms "a,b"` | a built-in list | Terms that make an item urgent. |
| `--notifications` / `--no-notifications` | on | Read the notifications. |
| `--comments` / `--no-comments` | on | Read comments on posts that concern the account and on the watched accounts' posts. |
| `--search` / `--no-search` | on | Search LinkedIn's posts for the company names and keywords. |

## How much

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval 60m` | 60 min | Time between passes. Minimum 30 min, spread ±20%. |
| `--max-searches 2` | 2 | Searches per pass (0–3), up to six terms each. |
| `--max-scrolls 2` | 2 | Scrolls per page to get back to what the last pass saw (0–4). |
| `--max-comment-reads 4` | 4 | Posts one pass may open for their comments (0–8). |
| `--max-age 72h` | 72 h | Older items are not announced. |

Durations accept `ms`, `s`, `m`, `h`, and `d`; a plain number means seconds.

## Browser and output

| Flag | Default | Meaning |
| --- | --- | --- |
| `--nbc PATH` | app's `nextctl`, then `nbc` | The CLI that drives the profile. `NBC_BIN` and `NEXTCTL_BIN` also work. |
| `--runtime-root DIR` | the app's | Where the app keeps profiles and sessions. |
| `--runtime NAME` | profile's own | Passed to nbc as `--runtime`. |
| `--no-start` | starts | Do not start the profile; fail if it is not running. |
| `--keep-tab` | parks | Leave the last page open instead of `about:blank`. |
| `--state FILE` | `~/.nextbrowser/linkedin-monitoring/<profile>.json` | Where the state is kept. |
| `--format text\|json` | text on a terminal | The format of stdout. |
| `--verbose` | off | The engine's log and every nbc call on stderr, as JSON lines. |

Settings given as flags are saved in the state file and apply to later runs too.

In `text` format a match takes two lines: the time, the urgency, who did what and what they wrote; then, indented, the reasons and the direct link.

```text
10:00  HIGH    Lee Park mentioned Acme: Acme had an outage this morning, anyone else seeing failed syncs?
        [Mentions your company · Says "outage" · Asks a question]  https://www.linkedin.com/feed/update/urn:li:activity:7512809084551169234/
```

The first line names how the item concerns you: `mentioned you in a post`, `mentioned you in a comment`, `replied to your comment`, `commented on your post`, `mentioned Acme`, `posted`, `reposted`, `commented on <author>'s post`; a plain keyword find from a search is marked `(search)`.

After each pass, one line sums it up, with the notes under it:

```text
11:00  pass Dana Reyes: 4 sources: 0 new of 11 matches; 1 via the posts tab
        Mila Novak was read from the posts tab: the activity page drew nothing.
```

In `json` format, stdout carries every [event](events-and-state.md#events), a `{"type":"pass","at":…,"summary":{…}}` after each pass, and `{"type":"error",…}` when the profile would not start.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Finished, or stopped with <kbd>Ctrl</kbd>+<kbd>C</kbd>. |
| `1` | An error, such as a profile that would not start under `once`, a pass that failed on an unexpected error, or a bad flag. |
| `2` | No command, or an unknown one. |
| `3` | `once` found the profile signed out. |
| `4` | `once` was stopped by a restriction or an unreachable linkedin.com. |
| `5` | `once` met a security check. |
| `130` | A second <kbd>Ctrl</kbd>+<kbd>C</kbd> while a pass was finishing. |

The search limit does not change the exit code: the pass read everything else.
