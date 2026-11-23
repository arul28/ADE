/**
 * What every ADE Cloud iPhone provider gives `phones.ts`: one record per
 * provider (`NOMAC_PHONE` in `phoneNomac.ts`, `REVYL_PHONE` in
 * `phoneRevyl.ts`), and the phone shape both answer in (NoMac's session
 * shape). `phones.ts` keeps the rows, minutes, access and routes, the same for
 * both, and never asks which provider it has.
 */

import type { CloudPhoneDevice, CloudPhoneProvider, CloudPhoneStart, CloudPhoneView } from "./contract";
import type { CloudEnv } from "./store";

/** The token a brain drives the phone with. */
export const TOKEN_MINUTES = 120;
/** A view link's life. */
export const VIEW_MINUTES = 120;

export const LIVE_STATES = new Set(["queued", "provisioning", "ready"]);

/** One phone as a provider answers it, in NoMac's session shape. */
export type PhoneSession = {
  id: string;
  state: string;
  device?: string;
  label?: string | null;
  ready_at?: string | null;
  created_at?: string;
  shutdown_at?: string | null;
  queue_expires_at?: string | null;
  end_reason?: string | null;
  failure_code?: string | null;
  ended?: { reason?: string | null; at?: string | null } | null;
  cost?: { billed_seconds?: number; accrued_microunits?: string };
  /** Who runs it (absent: NoMac), and the provider's own second id for it (Revyl's workflow run). */
  provider?: CloudPhoneProvider;
  ref?: string | null;
};

/** One phone as its provider answers it now. */
export type PhoneRead = { session: PhoneSession; stopNotice: unknown };

/** Where a known phone runs: its row's provider, its second id and its model. */
export type PhoneWhere = { provider: CloudPhoneProvider; ref: string | null; device: string | null };

/** A stop's answer: refused (it is tried again later), or taken, with the phone as read just after (null: unread). */
export type PhoneStopped =
  | { ok: false; status: number; code: string }
  | { ok: true; status: number; after: PhoneRead | null };

/** A provider's stop answer it refused (a phone already gone, 404, is stopped). */
export const stopRefused = (status: number): boolean => status >= 400 && status !== 404;

export const isoMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** A provider's code as a Sentry event name part: its own closed codes, or `http_<status>`. */
export const sentryCode = (code: string): string => code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "unknown";

export type PhoneProviderServer = {
  /** It may start new phones here: its key set (and for Revyl, its switch on: `revylEnabled`). */
  canStart(env: CloudEnv): boolean;
  /** Its key is set: phones already running there are still read, held to their minutes and stopped. */
  hasKey(env: CloudEnv): boolean;
  /**
   * The phone stops by itself at what the account may use (NoMac's time limit
   * and spend cap). False (Revyl): the phone's `stop_at`, written at its start,
   * is its limit.
   */
  ownsTimeLimit: boolean;
  /** The Sentry event a refused stop is reported as, before the provider's code. */
  stopFailedEvent: string;
  /**
   * Starts the account's phone, or answers the one already running there. A
   * refusal answers 502 (or 504) whenever the provider may have made a phone
   * anyway: a 5xx or a timeout to the start itself, or a success it couldn't
   * read. Any other status says no phone was made (`definitelyRefused`).
   */
  start(env: CloudEnv, input: { userId: string; label: string; device: CloudPhoneDevice | undefined; minutes: number; lastPhoneId: string | null; now: number }): Promise<{ session: PhoneSession; reused: boolean } | Response>;
  /** One phone as the provider answers it now, or null when it can't be read. */
  read(env: CloudEnv, userId: string, phoneId: string, where: PhoneWhere): Promise<PhoneRead | null>;
  /** Stops one phone, then reads it. */
  stop(env: CloudEnv, userId: string, phoneId: string, where: PhoneWhere): Promise<PhoneStopped>;
  /** What a brain drives the started phone with (`CloudPhoneStart`'s `token` and `apiBase`). */
  startAnswer(env: CloudEnv, session: PhoneSession, userId: string, now: number): Promise<Pick<CloudPhoneStart, "token" | "apiBase"> | Response>;
  /** A view link for the live phone. */
  view(env: CloudEnv, input: { userId: string; phone: { id: string; ref: string | null }; label: string; control: boolean; origin: string; now: number }): Promise<CloudPhoneView | Response>;
  /** `POST /cloud/phone/call` for a provider with no per-phone token (Revyl); absent: the phone takes its calls directly. */
  call?: (env: CloudEnv, userId: string, phone: { id: string; ref: string | null }, body: Record<string, unknown>, now: number) => Promise<Response>;
};
