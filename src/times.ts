// Reading the time LinkedIn draws beside a post, a comment or a notification.
//
// LinkedIn draws a relative label — "now", "5m", "3h", "2d", "1w", "3mo",
// "1yr" — followed by "• Edited" and a visibility icon, and for screen readers
// a longer one: "3 hours ago". Neither is what decides whether something is
// new: a post's and a comment's id carry the moment they were made (ids.ts),
// to the millisecond. A drawn time is only the fallback for something whose
// id the page did not give, and a bound for the rest.
//
// Every label read here becomes a range, never a point: "3h" means at least
// three hours and less than four, so the item was created between four and
// three hours before the page was read. A month is taken as 30 days and a
// year as 365. Anything else — a date, another language — returns undefined.

export interface TimeRange {
  /** The earliest the item can have been created, ms since the epoch. */
  earliest: number;
  /** The latest the item can have been created. */
  latest: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// "mo" is a month and "m" a minute: each pattern is matched whole.
const UNITS: [RegExp, number][] = [
  [/^(?:s|sec|secs|second|seconds)$/, 1000],
  [/^(?:m|min|mins|minute|minutes)$/, MINUTE],
  [/^(?:h|hr|hrs|hour|hours)$/, HOUR],
  [/^(?:d|day|days)$/, DAY],
  [/^(?:w|wk|wks|week|weeks)$/, 7 * DAY],
  [/^(?:mo|mos|month|months)$/, 30 * DAY],
  [/^(?:y|yr|yrs|year|years)$/, 365 * DAY],
];

/** cleanTimeLabel keeps the time out of what LinkedIn draws around it:
 *  "3h • Edited • " becomes "3h". */
export function cleanTimeLabel(label: string | null | undefined): string {
  return String(label ?? "")
    .split(/[•·]/)[0]!
    .replace(/\s+/g, " ")
    .trim();
}

/** drawnTimeRange reads a drawn label against the time the page was read. */
export function drawnTimeRange(label: string | null | undefined, readAt: number): TimeRange | undefined {
  const text = cleanTimeLabel(label)
    .toLowerCase()
    .replace(/\s+ago$/, "")
    .replace(/^about\s+/, "")
    .replace(/^edited\s+/, "");
  if (!text) return undefined;
  if (/^(just now|now)$/.test(text)) return { earliest: readAt - MINUTE, latest: readAt };
  const match = /^(an?|\d{1,3}) ?([a-z]+)$/.exec(text);
  if (!match) return undefined;
  const count = match[1] === "a" || match[1] === "an" ? 1 : Number(match[1]);
  const unit = UNITS.find(([pattern]) => pattern.test(match[2] ?? ""));
  if (!unit || !Number.isFinite(count)) return undefined;
  const size = unit[1];
  return { earliest: readAt - (count + 1) * size, latest: readAt - count * size };
}
