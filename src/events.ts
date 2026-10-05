// What a pass reports. Events are plain JSON, so a caller can store them, send
// them over IPC, or print them one per line.

import type { AccountRef } from "./ids.js";
import type { LinkedInItem } from "./items.js";
import type { Triage } from "./triage.js";

/** Where an item was found. */
export interface ItemSource {
  /** "notifications": a card in the account's notifications;
   *  "account": a watched person's or company's posts;
   *  "search": LinkedIn's post search;
   *  "comments": the comments on a post one of the others surfaced. */
  kind: "notifications" | "account" | "search" | "comments";
  /** "notifications", the watched account's name, or the search query; for
   *  comments, the name of the source the post was found in. */
  name: string;
  /** The watched account, for kind "account" (and comments on its posts). */
  account?: AccountRef;
  /** The query, for kind "search" (and comments on what it found). */
  query?: string;
}

/** An item that matched, ranked, with where it came from. It is what a
 *  new_item event carries, and what a pass hands back for a dashboard. */
export interface Match {
  item: LinkedInItem;
  source: ItemSource;
  /** The keywords it names (your company names are in item.company). */
  keywords: string[];
  triage: Triage;
}

/** Something new that needs a look: a mention, a reply, a comment on the
 *  account's post, a watched account's new post, a post or a comment that
 *  names your company or a keyword. */
export interface NewItemEvent extends Match {
  type: "new_item";
  at: number;
  /** The monitored account. */
  account?: string;
}

/** The profile is signed in to linkedin.com, for the first time or again. */
export interface SignedInEvent {
  type: "signed_in";
  at: number;
  handle?: string;
  name?: string;
}

/** The profile is signed out. Nothing on LinkedIn can be read until someone
 *  signs it in again. */
export interface SignedOutEvent {
  type: "signed_out";
  at: number;
  handle?: string;
}

/** A different member is signed in than before. Their notifications and
 *  their own posts start over. */
export interface AccountChangedEvent {
  type: "account_changed";
  at: number;
  previous: string;
  current: string;
}

/** LinkedIn stopped the session at a security check (a /checkpoint/ page)
 *  until a person completes it. */
export interface SecurityCheckEvent {
  type: "security_check";
  at: number;
  handle?: string;
}

export type MonitorEvent =
  | NewItemEvent
  | SignedInEvent
  | SignedOutEvent
  | AccountChangedEvent
  | SecurityCheckEvent;
