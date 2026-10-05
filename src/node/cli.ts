// linkedin-monitor: run the monitor against one Nextbrowser profile from a
// terminal.
//
// Events go to stdout, one JSON object per line (or readable lines with
// --format text), so another process can follow them; the log goes to stderr
// with --verbose. The state lives in a file between runs.

import { parseArgs } from "node:util";
import { runPass, type PassSummary } from "../engine.js";
import type { MonitorEvent } from "../events.js";
import { normalizeAccount } from "../ids.js";
import { splitKeywords } from "../keywords.js";
import type { LogEntry } from "../log.js";
import { DEFAULT_INTERVAL_MS, scheduleDelay } from "../schedule.js";
import { withSettings, type MonitorSettings, type MonitorState } from "../state.js";
import { nbcBrowser } from "./nbc.js";
import { defaultStatePath, loadState, saveState } from "./store.js";

const USAGE = `linkedin-monitor — watch LinkedIn for mentions, accounts and posts through a Nextbrowser profile

Usage:
  linkedin-monitor run   --profile NAME [options]   pass after pass until stopped
  linkedin-monitor once  --profile NAME [options]   one pass
  linkedin-monitor state --profile NAME [--state FILE]   print the saved state

The profile must be signed in to linkedin.com.

What is watched:
  --accounts a,b                 people and companies to watch: profile or company links,
                                 in/<slug> or company/<slug> (up to 10)
  --company "Acme,Acme Inc"      your company's names: always searched, a mention ranks high
  --keywords "a,b c"             words and phrases to find and search for
  --exclude "a,b"                words that drop an item even when a keyword matched
  --urgent-terms "a,b"           terms that make an item urgent (default: a built-in list)
  --notifications / --no-notifications   read your notifications (default: yes)
  --comments / --no-comments     read comments on posts that concern you (default: yes)
  --search / --no-search         search posts for the company names and keywords (default: yes)

How much:
  --interval 60m                 between passes (min 30m, spread ±20%)
  --max-searches 2               searches per pass (0-3)
  --max-scrolls 2                scrolls per page to get back to known posts (0-4)
  --max-comment-reads 4          posts one pass may open for their comments (0-8)
  --max-age 72h                  older items are not announced

Browser:
  --nbc PATH                     nbc or nextctl binary (default: the app's, then PATH)
  --runtime-root DIR             the app's runtime root (default: the app's)
  --runtime NAME                 nbc --runtime for the profile
  --no-start                     do not start the profile; fail if it is not running
  --keep-tab                     leave the last page open instead of about:blank

Output:
  --state FILE                   state file (default ~/.nextbrowser/linkedin-monitoring/<profile>.json)
  --format json|text             stdout format (default: text on a terminal, json otherwise)
  --verbose                      write the monitor's log to stderr as JSON lines

Settings given as flags are saved in the state file and kept for later runs.
`;

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: string, flag: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`${flag}: "${value}" is not a duration like 90s, 30m or 2h`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2] ?? "s"]!);
}

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${flag}: "${value}" is not a whole number`);
  return number;
}

const OPTIONS = {
  profile: { type: "string" },
  state: { type: "string" },
  interval: { type: "string" },
  accounts: { type: "string" },
  company: { type: "string" },
  keywords: { type: "string" },
  exclude: { type: "string" },
  "urgent-terms": { type: "string" },
  "max-searches": { type: "string" },
  "max-scrolls": { type: "string" },
  "max-comment-reads": { type: "string" },
  "max-age": { type: "string" },
  notifications: { type: "boolean" },
  "no-notifications": { type: "boolean" },
  comments: { type: "boolean" },
  "no-comments": { type: "boolean" },
  search: { type: "boolean" },
  "no-search": { type: "boolean" },
  nbc: { type: "string" },
  "runtime-root": { type: "string" },
  runtime: { type: "string" },
  "no-start": { type: "boolean" },
  "keep-tab": { type: "boolean" },
  format: { type: "string" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** toggle reads a --x / --no-x pair; the negative wins when both are given. */
function toggle(values: Values, name: string): boolean | undefined {
  const record = values as Record<string, unknown>;
  if (record[`no-${name}`]) return false;
  if (record[name]) return true;
  return undefined;
}

/** settingsFromFlags is the settings patch the flags ask for. */
export function settingsFromFlags(values: Values): Partial<MonitorSettings> {
  const patch: Partial<MonitorSettings> = {};
  const toggles: [string, keyof MonitorSettings][] = [
    ["notifications", "watchNotifications"],
    ["comments", "watchComments"],
    ["search", "searchKeywords"],
  ];
  for (const [flag, setting] of toggles) {
    const value = toggle(values, flag);
    if (value !== undefined) (patch as Record<string, unknown>)[setting] = value;
  }
  if (values.accounts !== undefined) {
    const accounts = values.accounts.split(/[\s,]+/).filter(Boolean);
    const invalid = accounts.filter((account) => !normalizeAccount(account));
    if (invalid.length) throw new Error(`--accounts: not a LinkedIn profile or company: ${invalid.join(", ")}`);
    patch.accounts = accounts.map((account) => normalizeAccount(account)!);
  }
  if (values.company !== undefined) patch.companyNames = splitKeywords(values.company);
  if (values.keywords !== undefined) patch.keywords = splitKeywords(values.keywords);
  if (values.exclude !== undefined) patch.excludeKeywords = splitKeywords(values.exclude);
  if (values["urgent-terms"] !== undefined) patch.urgentTerms = splitKeywords(values["urgent-terms"]);
  if (values["max-searches"] !== undefined) patch.maxSearches = positiveInteger(values["max-searches"], "--max-searches");
  if (values["max-scrolls"] !== undefined) patch.maxScrolls = positiveInteger(values["max-scrolls"], "--max-scrolls");
  if (values["max-comment-reads"] !== undefined) patch.maxCommentReads = positiveInteger(values["max-comment-reads"], "--max-comment-reads");
  if (values["max-age"] !== undefined) patch.maxItemAgeMs = parseDuration(values["max-age"], "--max-age");
  if (values["keep-tab"]) patch.parkTab = false;
  return patch;
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : /(s|sh|ch|x)$/.test(noun) ? `${noun}es` : `${noun}s`}`;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const LEVEL = { high: "HIGH", medium: "MEDIUM", low: "low" } as const;

/** describeEvent is the readable text for an event. A new item takes two
 *  lines: who did what and how urgent, then why and where to open it. */
export function describeEvent(event: MonitorEvent): string {
  switch (event.type) {
    case "new_item": {
      const { item, source, triage } = event;
      const author = item.author || "Someone";
      const on = item.post.author ? `${item.post.author}'s post` : "a post";
      let who: string;
      if (item.kind === "post") {
        who = item.addressed === "mention"
          ? `${author} mentioned you in a post`
          : item.company
            ? `${author} mentioned ${item.company}`
            : item.reshare && item.resharedBy
              ? `${item.resharedBy} reposted ${author}'s post`
              : item.reshare
                ? `${author} reposted`
                : `${author} posted`;
      } else {
        who = item.addressed === "mention"
          ? `${author} mentioned you in a comment`
          : item.addressed === "reply"
            ? `${author} replied to your comment`
            : item.addressed === "comment_on_post"
              ? `${author} commented on your post`
              : item.company
                ? `${author} mentioned ${item.company} on ${on}`
                : `${author} commented on ${on}`;
      }
      // A plain keyword find from a search says where it came from; the
      // other sources say it in the verb.
      const found = source.kind === "search" && !item.addressed && !item.company ? " (search)" : "";
      const body = oneLine(item.text) || "[no text]";
      const why = triage.reasons.length ? `[${triage.reasons.join(" · ")}]  ` : "";
      return `${time(event.at)}  ${LEVEL[triage.urgency].padEnd(6)}  ${who}${found}: ${body}\n        ${why}${item.url}`;
    }
    case "signed_in":
      return `${time(event.at)}  signed in${event.name || event.handle ? ` as ${event.name || event.handle}` : ""}`;
    case "signed_out":
      return `${time(event.at)}  signed out${event.handle ? ` (was ${event.handle})` : ""}: sign the profile in to linkedin.com`;
    case "account_changed":
      return `${time(event.at)}  account changed: ${event.previous} → ${event.current}; notifications and your own posts start over`;
    case "security_check":
      return `${time(event.at)}  security check${event.handle ? ` for ${event.handle}` : ""}: open linkedin.com in the profile and complete it`;
  }
}

/** describePass is the readable line for a finished pass. */
export function describePass(summary: PassSummary, at: number): string {
  const parts: string[] = [];
  if (summary.loginRequired) parts.push("not signed in");
  if (summary.sourcesRead) {
    const baseline = summary.baselines === summary.sourcesRead;
    parts.push(baseline
      ? `starting line: ${plural(summary.sourcesRead, "source")}, ${plural(summary.matches, "match")}`
      : `${plural(summary.sourcesRead, "source")}: ${summary.newItems} new${summary.urgent ? ` (${summary.urgent} urgent)` : ""} of ${plural(summary.matches, "match")}`);
  }
  if (summary.fallbacks) parts.push(`${summary.fallbacks} via the posts tab`);
  if (summary.unreadable) parts.push(`${plural(summary.unreadable, "source")} not read`);
  if (summary.searchLimited) parts.push("search limit reached");
  if (summary.commentReads) parts.push(`${plural(summary.commentReads, "thread")} read`);
  if (summary.securityCheck) parts.push("security check");
  else if (summary.rateLimited) parts.push("restricted");
  else if (summary.blocked) parts.push("blocked");
  if (summary.stopped) parts.push("stopped");
  const who = summary.handle ? ` ${summary.handle}` : "";
  return `${time(at)}  pass${who}: ${parts.join("; ") || "nothing read"}${summary.notes.length ? `\n        ${summary.notes.join("\n        ")}` : ""}`;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const command = positionals[0] ?? "";
  if (values.help || !["run", "once", "state"].includes(command)) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const profile = values.profile?.trim();
  if (!profile && !(command === "state" && values.state)) throw new Error("--profile is required");
  const statePath = values.state ?? defaultStatePath(profile ?? "");
  let state: MonitorState = withSettings(await loadState(statePath), settingsFromFlags(values));
  if (command === "state") {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }

  const format = values.format ?? (process.stdout.isTTY ? "text" : "json");
  if (format !== "json" && format !== "text") throw new Error(`--format: "${format}" is neither json nor text`);
  const intervalMs = values.interval !== undefined ? parseDuration(values.interval, "--interval") : DEFAULT_INTERVAL_MS;
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const log = values.verbose ? (entry: LogEntry) => process.stderr.write(`${JSON.stringify(entry)}\n`) : undefined;
  const browser = nbcBrowser({
    profile: profile!,
    ...(values.nbc ? { binary: values.nbc } : {}),
    ...(values["runtime-root"] ? { runtimeRoot: values["runtime-root"] } : {}),
    ...(values.runtime ? { runtime: values.runtime } : {}),
    ...(values.verbose ? { trace: (entry) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ev: "nbc", ...entry })}\n`) } : {}),
  });

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await saveState(statePath, state);
  const wait = (delay: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = undefined;
    });

  for (;;) {
    if (!values["no-start"]) {
      try {
        await browser.start();
      } catch (error) {
        if (command === "once") throw error;
        const message = error instanceof Error ? error.message : String(error);
        const at = Date.now();
        print(format === "json" ? JSON.stringify({ type: "error", at, error: message }) : `${time(at)}  the profile did not start: ${message}`);
        await wait(scheduleDelay(intervalMs));
        if (stopping) return 0;
        continue;
      }
    }
    const result = await runPass({
      browser,
      state,
      ...(log ? { log } : {}),
      shouldStop: () => stopping,
      onEvent: (event) => print(format === "json" ? JSON.stringify(event) : describeEvent(event)),
    });
    state = result.state;
    await saveState(statePath, state);
    const at = state.lastPass?.at ?? Date.now();
    print(format === "json" ? JSON.stringify({ type: "pass", at, summary: result.summary }) : describePass(result.summary, at));
    const backOff = !!result.summary.blocked || result.summary.rateLimited || result.summary.securityCheck;
    if (command === "once" || stopping) return result.summary.securityCheck ? 5 : backOff ? 4 : result.summary.loginRequired ? 3 : 0;
    await wait(scheduleDelay(intervalMs, { backOff: backOff || result.summary.loginRequired }));
    if (stopping) return 0;
  }
}
