/**
 * The ADE Cloud invite page's facts (`/invite/<code>`). The rules live on the
 * account directory (`apps/account-directory/src/cloud/referrals.ts`); this is
 * only what the page needs: the code's shape, the app link, and the public
 * lookup that answers the inviter's first name.
 *
 * The hours and days come from the account directory's own plan facts
 * (`cloudPricing.ts`). The code's shape below is a copy of the one in
 * `apps/account-directory/src/cloud/contract.ts`, named next to it. Change
 * both together.
 */
import { FREE_PLAN, INVITE_RULES } from "./cloudPricing";

/** `CLOUD_INVITE_CODE_LENGTH` (8) characters of `CLOUD_INVITE_ALPHABET` (no 0/O/1/I/L); `parseCloudInviteCode` reads a code the same way. */
const INVITE_CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

const DEFAULT_ACCOUNT_DIRECTORY = "https://ade-account-directory-production.arulsharma1028.workers.dev";
const ACCOUNT_DIRECTORY =
  ((import.meta.env.VITE_ADE_ACCOUNT_DIRECTORY_URL as string | undefined)?.trim() || DEFAULT_ACCOUNT_DIRECTORY).replace(/\/+$/, "");

/** The code in the page's address, or null when it can't be one. */
export function inviteCodeFrom(raw: string | undefined): string | null {
  const code = (raw ?? "").replace(/[\s-]+/g, "").toUpperCase();
  return INVITE_CODE.test(code) ? code : null;
}

/** What "Open in ADE" opens (`CLOUD_INVITE_DEEPLINK_BASE`): the app fills the code in Settings › Account. */
export const inviteAppLink = (code: string): string => `ade://invite/${code}`;

/** Free hours every month. */
export const FREE_MONTHLY_HOURS = FREE_PLAN.hours;
/** What an invite adds for both people. */
export const INVITE_REWARD_HOURS = INVITE_RULES.rewardHours;
/** Days after signing up that a friend's code can still be entered. */
export const INVITE_ENTER_DAYS = INVITE_RULES.enterDays;

export type InviteLookup =
  | { state: "found"; firstName: string | null }
  | { state: "not_found" }
  | { state: "unavailable" };

/** The inviter's first name, from the public lookup. Never sends anything but the code. */
export async function lookUpInvite(code: string, signal?: AbortSignal): Promise<InviteLookup> {
  try {
    const response = await fetch(`${ACCOUNT_DIRECTORY}/invites/${encodeURIComponent(code)}`, { signal, credentials: "omit" });
    if (response.status === 404) return { state: "not_found" };
    if (!response.ok) return { state: "unavailable" };
    const body = (await response.json()) as { firstName?: unknown };
    const firstName = typeof body.firstName === "string" && body.firstName.trim() ? body.firstName.trim() : null;
    return { state: "found", firstName };
  } catch {
    return { state: "unavailable" };
  }
}
