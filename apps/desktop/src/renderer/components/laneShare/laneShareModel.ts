import { parseCodedErrorMessage, isUnsupportedAdeActionError } from "../../../shared/codedError";
import { laneSharePresetLabel, laneSharePresetRights, type LaneSharePresetName, type LaneShareRights, type LaneShareRiskLevel } from "../../../shared/laneShareRights";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { LANE_SHARING_UNAVAILABLE, LANE_SHARING_UNAVAILABLE_MESSAGE } from "../../../shared/laneShareDirectory";
import type { OpenProjectBinding } from "../../../shared/types";
import { rootAppStoreApi } from "../../state/appStore";

/**
 * Pure helpers for the owner's lane sharing UI: states, quick end dates,
 * usage text and the plain reason behind a failed call. No rights rules
 * live here; those are `shared/laneShareRights.ts`.
 */

/** Shares that count toward the limit and give access (or will). */
export function isLiveLaneShare(entry: Pick<LaneShareGivenEntry, "state">): boolean {
  return entry.state === "pending" || entry.state === "active";
}

/** How far a share's directory time may run behind this computer's clock and still count as new. */
export const AGENT_SHARE_NOTICE_CLOCK_SKEW_MS = 5 * 60_000;

/** On the first read of a list, how recent an agent's share must be to get the notice. */
export const AGENT_SHARE_NOTICE_FIRST_READ_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The shares of one machine's list that get the owner's "An agent shared"
 * notice: made by an agent on that machine, still live, never noticed here,
 * and made after this computer last read that list (less the clock skew).
 * On a first read of the list (`lastListAt` null: a new project, a new
 * machine, a forgotten list), only shares of the last 24 hours count, so an
 * old install does not show every share it ever made.
 */
export function agentSharesToNotice(
  shares: readonly LaneShareGivenEntry[],
  seen: { grantIds: ReadonlySet<string>; lastListAt: number | null },
  now: number = Date.now(),
): LaneShareGivenEntry[] {
  const since = seen.lastListAt ?? now - AGENT_SHARE_NOTICE_FIRST_READ_WINDOW_MS;
  return shares.filter((entry) =>
    entry.local
    && entry.createdBy === "agent"
    && isLiveLaneShare(entry)
    && !seen.grantIds.has(entry.grantId)
    && entry.createdAt != null
    && entry.createdAt > since - AGENT_SHARE_NOTICE_CLOCK_SKEW_MS);
}

/** The live shares of one lane, plus its expired invites (they can be sent again). */
export function laneSharesForLane(shares: readonly LaneShareGivenEntry[], laneId: string): LaneShareGivenEntry[] {
  return shares.filter((entry) => entry.laneId === laneId && (isLiveLaneShare(entry) || entry.state === "expired"));
}

/** A quiet summary for the lane mark: null when the lane is not shared. */
export type LaneShareMarkSummary = {
  live: number;
  pending: number;
  present: number;
  label: string;
};

export function laneShareMarkSummary(shares: readonly LaneShareGivenEntry[], laneId: string): LaneShareMarkSummary | null {
  const live = shares.filter((entry) => entry.laneId === laneId && isLiveLaneShare(entry));
  if (live.length === 0) return null;
  const pending = live.filter((entry) => entry.state === "pending").length;
  const present = live.filter((entry) => entry.connectedDevices > 0).length;
  const people = live.length === 1 ? "1 person" : `${live.length} people`;
  const parts = [`Shared with ${people}`];
  if (pending > 0) parts.push(`${pending} invite${pending === 1 ? "" : "s"} pending`);
  if (present > 0) parts.push(`${present} here now`);
  return { live: live.length, pending, present, label: parts.join(" · ") };
}

export type LaneShareStateTone = "ok" | "warn" | "crit" | null;

/** An invite that can no longer be accepted (the directory's `expired`, or a pending invite past its time). */
export function laneShareInviteExpired(entry: { state: string; inviteExpiresAt: number | null }, now = Date.now()): boolean {
  return entry.state === "expired" || (entry.state === "pending" && entry.inviteExpiresAt != null && entry.inviteExpiresAt <= now);
}

/**
 * The state tag of a share as the directory reports it, the same for the
 * owner and the guest. A revoked share reads "Ended" on both sides.
 */
export function laneShareGrantStateLabel(
  entry: { state: string; inviteExpiresAt: number | null },
  now = Date.now(),
): { label: string; tone: LaneShareStateTone } {
  if (laneShareInviteExpired(entry, now)) return { label: "Invite expired", tone: "warn" };
  switch (entry.state) {
    case "pending":
      return { label: "Invite", tone: null };
    case "active":
      return { label: "Active", tone: null };
    case "ended":
    case "revoked":
      return { label: "Ended", tone: null };
    case "left":
      return { label: "Left", tone: null };
    default:
      return { label: entry.state, tone: null };
  }
}

/** The state tag of one guest row on the owner's side: the lane's own state first, then the share's. */
export function laneShareStateLabel(entry: LaneShareGivenEntry, now = Date.now()): { label: string; tone: LaneShareStateTone } {
  if (entry.laneState === "missing") return { label: "Lane deleted", tone: "crit" };
  if (entry.laneState === "archived" && isLiveLaneShare(entry)) return { label: "Paused", tone: "warn" };
  if (entry.needsRights) return { label: "Needs rights", tone: "warn" };
  if (entry.state === "active" && entry.connectedDevices > 0) return { label: "Here now", tone: "ok" };
  return laneShareGrantStateLabel(entry, now);
}

export type LaneShareQuickEnd = { key: "hour" | "today" | "week" | "none"; label: string; at: number | null };

/** The end of the local day of `now` (the last millisecond before midnight). */
export function endOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(23, 59, 0, 0);
  return date.getTime();
}

export function laneShareQuickEnds(now: number): LaneShareQuickEnd[] {
  return [
    { key: "hour", label: "1 hour", at: now + 60 * 60 * 1000 },
    { key: "today", label: "Today", at: endOfLocalDay(now) },
    { key: "week", label: "1 week", at: now + 7 * 24 * 60 * 60 * 1000 },
    { key: "none", label: "No end", at: null },
  ];
}

const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function formatLaneShareEnd(endsAt: number | null): string {
  return endsAt == null ? "No end date" : `Ends ${dateTime.format(new Date(endsAt))}`;
}

/** "12 of 50 today", "12 of 200", "12 messages", or null when nothing was counted here. */
export function laneShareUsageText(entry: LaneShareGivenEntry): string | null {
  const usage = entry.usage;
  if (!usage) return null;
  const limits = entry.rights?.limits;
  if (limits?.messagesPerDay != null) return `${usage.today} of ${limits.messagesPerDay} today`;
  if (limits?.messagesTotal != null) return `${usage.total} of ${limits.messagesTotal}`;
  return `${usage.total} message${usage.total === 1 ? "" : "s"}`;
}

export const LANE_SHARE_PRESET_LABELS: Record<string, string> = {
  watch: "Watch",
  comment: "Comment",
  suggest: "Suggest",
  collaborate: "Collaborate",
};

export function laneSharePresetText(preset: string | null | undefined): string {
  return (preset && LANE_SHARE_PRESET_LABELS[preset]) || "Custom";
}

export const LANE_SHARE_RISK_LABELS: Record<LaneShareRiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** Rights compared as stored, so "Save" is enabled only after a change. */
export function sameLaneShareRights(a: LaneShareRights | null, b: LaneShareRights | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A plain reason for a failed lane share call, and whether the sheet must stay read only. */
export type LaneShareProblem = {
  code: string | null;
  message: string;
  /** True: nothing on this machine can change until the cause is fixed (signed out, offline, old host). */
  blocking: boolean;
};

/**
 * The sentence for each error code that means the same on the owner's and
 * the guest's side. `laneShareProblem` (owner) and `laneShareGuestProblem`
 * (guest) both read it.
 */
export const LANE_SHARE_ERROR_TEXT: Readonly<Record<string, string>> = {
  signed_out: "Sign in to your ADE account to share lanes.",
  no_directory: "Shared lanes need your ADE account on this device. Sign in from Settings, then try again.",
  [LANE_SHARING_UNAVAILABLE]: LANE_SHARING_UNAVAILABLE_MESSAGE,
  unavailable: "The ADE account directory can't be reached right now. Try again in a moment.",
  rate_limited: "Too many tries. Wait a moment, then try again.",
  invite_expired: "This invite expired. Ask the owner to send it again.",
  guest_limit: "This lane already has the most guests it can have. Ask the owner.",
  share_closed: "This share has ended.",
};

const MISSING_DOMAIN_PATTERN = /Domain ['"]lane_share['"] is unavailable in this runtime/i;
const OFFLINE_PATTERN = /\b(offline|disconnected|not connected|unreachable|timed out|no route|could not reach|isn'?t reachable|not reachable)\b/i;

export function laneShareProblem(error: unknown, options: { pin?: OpenProjectBinding | null; machineName?: string | null } = {}): LaneShareProblem {
  const parsed = parseCodedErrorMessage(error);
  const code = parsed.code ?? null;
  const message = parsed.message || "Lane sharing failed.";
  if (code === "signed_out" || code === "unauthorized") {
    return { code, message: LANE_SHARE_ERROR_TEXT.signed_out!, blocking: true };
  }
  if (code === "no_directory") {
    return { code, message: LANE_SHARE_ERROR_TEXT.no_directory!, blocking: true };
  }
  if (code === "lane_share_no_runtime" || code === "lane_share_desktop_only") {
    return { code, message, blocking: true };
  }
  // The runtime has no `lane_share` domain. The RPC server sends no code for
  // this (a bare JSON-RPC invalidParams, and IPC drops codes anyway), so the
  // match is on its fixed sentence. A remote machine reached over sync has a
  // sync service, so there it means an older ADE; on this computer it means
  // the sync service is off.
  if (MISSING_DOMAIN_PATTERN.test(message)) {
    const target = options.pin ?? rootAppStoreApi.getState().projectBinding ?? null;
    if (target?.kind === "remote") {
      const where = options.machineName ?? target.runtimeName ?? "That computer";
      return { code: "old_host", message: `${where} runs an older ADE. Update it to share lanes.`, blocking: true };
    }
    return { code: "sync_off", message: "Lane sharing needs sync on this computer. Turn sync on in Settings.", blocking: true };
  }
  if (isUnsupportedAdeActionError(error) || /lane_share/i.test(message) && /\b(unknown|not supported|unsupported|not available|not callable|not exposed)\b/i.test(message)) {
    const where = options.machineName ? options.machineName : "That computer";
    return { code: "old_host", message: `${where} can't share lanes: it runs an ADE version without lane sharing, or sync is off there. Update ADE or turn on sync there.`, blocking: true };
  }
  if (options.pin?.kind === "remote" && OFFLINE_PATTERN.test(message)) {
    const where = options.machineName ?? options.pin.runtimeName ?? "The lane's computer";
    return { code: "offline", message: `${where} is offline. Sharing opens read only until it is back.`, blocking: true };
  }
  if (code === LANE_SHARING_UNAVAILABLE) return { code, message: LANE_SHARING_UNAVAILABLE_MESSAGE, blocking: true };
  return { code, message: (code && LANE_SHARE_ERROR_TEXT[code]) || message, blocking: false };
}

/** A short line about the invite email of a create or re-send. */
export function laneShareEmailNote(directory: { emailSent?: boolean; emailNotSentReason?: string | null } | null | undefined): string | null {
  if (!directory || directory.emailSent !== false) return null;
  switch (directory.emailNotSentReason) {
    case "not_configured":
      return "No email went out: invite emails are not set up yet. Copy the link and send it yourself.";
    case "rate_limited":
      return "No email went out: an invite can be sent again 10 minutes after the last one. The link still works.";
    default:
      return "The invite email could not be sent. Copy the link and send it yourself.";
  }
}

/** A preset's rights on top of `rights`: a preset changes what the person may do; privacy and the end date stay. */
export function withLaneSharePreset(rights: LaneShareRights, preset: LaneSharePresetName): LaneShareRights {
  const next = laneSharePresetRights(preset);
  return { ...next, privacy: rights.privacy, limits: { ...next.limits, endsAt: rights.limits.endsAt } };
}

/** The preset a rights object matches, or "custom" (privacy and the end date are the owner's own on top of any preset). */
export function laneShareRightsPreset(rights: LaneShareRights): LaneSharePresetName | "custom" {
  const label = laneSharePresetLabel(rights);
  return sameLaneShareRights(rights, withLaneSharePreset(rights, label)) ? label : "custom";
}

/** A share's access level as every row names it: from its rights when this computer has them (Custom included), else the directory's label. */
export function laneShareAccessText(entry: Pick<LaneShareGivenEntry, "rights" | "preset">): string {
  if (!entry.rights) return laneSharePresetText(entry.preset);
  const preset = laneShareRightsPreset(entry.rights);
  return preset === "custom" ? "Custom" : LANE_SHARE_PRESET_LABELS[preset] ?? "Custom";
}
