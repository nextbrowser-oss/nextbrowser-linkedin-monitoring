// Renders assets/linkedin-monitor-terminal.svg, the terminal shown at the top
// of the README. Every line comes from the CLI's own formatters
// (dist/node/cli.js), so the picture shows exactly what `linkedin-monitor run`
// prints; the accounts, people, posts and numbers are sample data.
//
//   npm run build && npm run render:terminal

import { writeFile } from "node:fs/promises";
import { describeEvent, describePass } from "../dist/node/cli.js";

const at = (hour, minute) => new Date(2026, 9, 5, hour, minute).getTime();
const urn = (id) => `urn:li:activity:${id}`;
const postLink = (id) => `https://www.linkedin.com/feed/update/${urn(id)}/`;
const post = (id, author, text, extra = {}) => ({
  key: `post:${id}`, id, kind: "post", author, text, url: postLink(id),
  post: { id, urn: urn(id), url: postLink(id), author, text }, ...extra,
});
const found = (time, item, source, urgency, reasons, keywords = []) => ({
  type: "new_item", at: time, account: "Dana Reyes", item, source, keywords, triage: { urgency, score: 0, reasons },
});
const pass = (patch) => ({
  signedIn: true, handle: "Dana Reyes", loginRequired: false, securityCheck: false, rateLimited: false, searchLimited: false,
  pagesLoaded: 0, sourcesRead: 4, baselines: 0, fallbacks: 0, unreadable: 0, searches: 1, itemsRead: 0, scrolls: 0,
  matches: 0, newItems: 0, urgent: 0, commentReads: 0, commentReadsDeferred: 0, stopped: false, notes: [], ...patch,
});

const QUERY = "Acme OR invoicing";
const search = { kind: "search", name: QUERY, query: QUERY };
const notifications = { kind: "notifications", name: "notifications" };
const northwind = { kind: "account", name: "Northwind", account: { kind: "company", slug: "northwind" } };

const lines = [
  describeEvent({ type: "signed_in", at: at(9, 0), handle: "Dana Reyes", name: "Dana Reyes" }),
  describePass(pass({ baselines: 4, matches: 6 }), at(9, 0)),
  describeEvent(found(at(10, 0), post("7512807092256769234", "Mila Novak", "Dana Reyes, is SSO with Okta on the roadmap for this quarter?", { addressed: "mention", replies: 2 }),
    notifications, "high", ["Mentions you", "Asks a question"])),
  describeEvent(found(at(10, 0), post("7512809084551169234", "Lee Park", "Acme had an outage this morning, anyone else seeing failed syncs?", { company: "Acme", replies: 3 }),
    search, "high", ["Mentions your company", 'Says "outage"', "Asks a question"])),
  describeEvent(found(at(10, 0), post("7512804462428161234", "Ana Lima", "Looking for recommendations on an invoicing tool for a 20-person agency", { replies: 0 }),
    search, "medium", ["Asks for a recommendation", "No comments yet"], ["invoicing"])),
  describeEvent(found(at(10, 0), post("7512800125517825234", "Northwind", "Northwind Pay is now live in 12 new countries", { replies: 14 }),
    northwind, "low", [])),
  describePass(pass({ matches: 9, newItems: 4, urgent: 2, commentReads: 2 }), at(10, 0)),
];

const COLORS = {
  background: "#0b1120",
  bar: "#111827",
  border: "#1f2937",
  text: "#e5e7eb",
  dim: "#6b7280",
  prompt: "#2dd4bf",
  high: "#f87171",
  medium: "#fbbf24",
  low: "#94a3b8",
  counts: "#60a5fa",
  pass: "#94a3b8",
  user: "#c4b5fd",
  company: "#5eead4",
  reasons: "#a7f3d0",
  link: "#64748b",
};

const PEOPLE = ["Dana Reyes", "Mila Novak", "Lee Park", "Ana Lima"];
const COMPANIES = ["Northwind", "Acme"];
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOKEN = new RegExp(
  `(\\bHIGH\\b|\\bMEDIUM\\b|(?<=^\\s{2})low\\b|\\bsigned in\\b|\\bpass(?= )|https:\\/\\/\\S+|\\[[^\\]]*\\]|${PEOPLE.map(literal).join("|")}|${COMPANIES.map((name) => `\\b${literal(name)}\\b`).join("|")})`,
  "g",
);

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colorOf(token) {
  if (token === "HIGH") return COLORS.high;
  if (token === "MEDIUM") return COLORS.medium;
  if (token === "low") return COLORS.low;
  if (token === "signed in") return COLORS.counts;
  if (token === "pass") return COLORS.pass;
  if (token.startsWith("https://")) return COLORS.link;
  if (token.startsWith("[")) return COLORS.reasons;
  if (COMPANIES.includes(token)) return COLORS.company;
  if (PEOPLE.includes(token)) return COLORS.user;
  return COLORS.dim;
}

function spans(line) {
  const time = line.slice(0, 5);
  const rest = line.slice(5);
  const parts = [`<tspan fill="${COLORS.dim}">${escape(time)}</tspan>`];
  let last = 0;
  for (const match of rest.matchAll(TOKEN)) {
    if (match.index > last) parts.push(escape(rest.slice(last, match.index)));
    parts.push(`<tspan fill="${colorOf(match[0])}">${escape(match[0])}</tspan>`);
    last = match.index + match[0].length;
  }
  parts.push(escape(rest.slice(last)));
  return parts.join("");
}

// An event or a pass carries its details on the lines under it. LinkedIn's
// links are long, so the font is a size smaller than the other monitors'.
const rowsText = lines.flatMap((line) => line.split("\n"));
const FONT_SIZE = 13;
const LINE = 24;
const CHAR = FONT_SIZE * 0.6;
const PAD = 28;
const BAR = 40;
const command = "$ linkedin-monitor run --profile acme --company Acme --keywords invoicing --accounts in/mila-novak,company/northwind";
const longest = Math.max(command.length, ...rowsText.map((line) => line.length));
const width = Math.ceil(PAD * 2 + longest * CHAR);
const height = BAR + PAD + LINE * (rowsText.length + 1) + PAD - 6;

const rows = [
  `<text x="${PAD}" y="${BAR + PAD + 4}"><tspan fill="${COLORS.prompt}">$</tspan> ${escape(command.slice(2))}</text>`,
  ...rowsText.map((line, index) => `<text x="${PAD}" y="${BAR + PAD + 4 + LINE * (index + 1)}" xml:space="preserve">${spans(line)}</text>`),
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Example linkedin-monitor output: a mention, a company mention and a lead found by search, and a watched company's post, ranked by urgency, each with the reasons and a direct link">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${COLORS.background}" stroke="${COLORS.border}"/>
  <path d="M12.5 0.5h${width - 25}a12 12 0 0 1 12 12v${BAR - 12}h-${width - 1}v-${BAR - 12}a12 12 0 0 1 12-12z" fill="${COLORS.bar}"/>
  <circle cx="24" cy="20" r="6" fill="#ff5f57"/>
  <circle cx="44" cy="20" r="6" fill="#febc2e"/>
  <circle cx="64" cy="20" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="25" text-anchor="middle" fill="${COLORS.dim}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="13">linkedin-monitor — sample output</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}" fill="${COLORS.text}">
    ${rows.join("\n    ")}
  </g>
</svg>
`;

await writeFile(new URL("../assets/linkedin-monitor-terminal.svg", import.meta.url), svg);
console.log(`assets/linkedin-monitor-terminal.svg: ${width}x${height}, ${rowsText.length} lines`);
for (const line of rowsText) console.log(line);
