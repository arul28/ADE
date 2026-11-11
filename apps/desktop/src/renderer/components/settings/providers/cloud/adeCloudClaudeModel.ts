/**
 * Claude's page on ADE Cloud, as data: one card per Claude pass, the line
 * under the banner, and the smart balance switch's state. Pure: no reads, no
 * React. Every word the page says about a pass lives here (rows P1–P16 and
 * U1–U3 of the P7 design).
 *
 * The account part gives each pass's own fields (on, new chats, its dates).
 * Use comes from two reads joined per window (`joinedPassUse`): the
 * reporting cloud computer's pass turns, and the same Claude account's
 * numbers on one of the person's computers. A number from the account says
 * where it comes from; it never says "limit reached", since that reading has
 * no status.
 */
import type { ClaudePassUseView, ClaudePassUseWindow } from "../../../../../shared/cloudSignIns";
import {
  adeCloudPageLine,
  ADE_CLOUD_REACH_LINE,
  joinedPassUse,
  readClaudePasses,
  shortDate,
  type AdeCloudAccountPart,
  type AdeCloudCloudPart,
  type ReadableCloudPassRow,
} from "./adeCloudSignInModel";
import { agoText, dayText } from "./adeCloudPageModel";

export type PassLine = { text: string; tone: "warn" | "crit" | null };

export type PassWindowView = {
  label: string;
  /** 0–100 for the bar, or null: no current number (never drawn as 0 %). */
  pct: number | null;
  /** "Resets 3:40 PM", "reset since the last turn", "Limit reached until 3:40 PM", "no number yet". */
  note: string | null;
  tone: "crit" | null;
};

export type PassUseModel =
  | { kind: "none" }
  | {
    kind: "seen";
    windows: PassWindowView[];
    /** "From Mac Studio, 2 h ago" when a number is the account's on a computer, not the pass's own. */
    source: string | null;
  };

export type PassCardModel =
  | { kind: "unreadable"; key: string; title: string }
  | {
    kind: "pass";
    key: string;
    /** The email, else "Claude pass from Mar 2". */
    title: string;
    email: string | null;
    on: boolean;
    newChats: boolean;
    ended: boolean;
    /** P3: only for a pressed account Claude did not confirm. */
    checkLine: string | null;
    /** P4: "Made on Mac Studio · Nov 10 · Renewed today". */
    madeLine: string;
    /** P5–P8. */
    stateLine: PassLine;
    /** Ending, past its expected end, or ended: Renew shows on the card. */
    renewNow: boolean;
    use: PassUseModel;
    /** P14 / P15: the pass is kept on this computer for now. */
    uploadLine: string | null;
  };

/** "3:40 PM" today, else "Nov 14, 3:40 PM". */
function resetText(ms: number, now: number): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function windowView(label: string, window: ClaudePassUseWindow | null, now: number): PassWindowView | null {
  if (!window) return null;
  // P13: only the pass's own turn carries Claude's status.
  if (window.status === "rejected") {
    return { label, pct: 100, note: window.resetsAt != null ? `Limit reached until ${resetText(window.resetsAt, now)}` : "Limit reached", tone: "crit" };
  }
  // P12: the share is from before the reset, so it is not shown.
  if (window.resetSinceSeen) {
    return { label, pct: null, note: window.from.kind === "pass_turn" ? "reset since the last turn" : "reset since then", tone: null };
  }
  // P11: no number is not 0 %.
  if (window.usedPct == null) return { label, pct: null, note: "no number yet", tone: null };
  return {
    label,
    pct: Math.max(0, Math.min(100, window.usedPct)),
    note: window.resetsAt != null ? `Resets ${resetText(window.resetsAt, now)}` : null,
    tone: null,
  };
}

/** U1–U3: the bars, and where the numbers come from when they are the account's. */
export function passUseModel(use: ClaudePassUseView, now: number): PassUseModel {
  if (use.state !== "seen") return { kind: "none" };
  const windows = [windowView("5-hour", use.fiveHour, now), windowView("Weekly", use.weekly, now)].filter((view): view is PassWindowView => Boolean(view));
  if (windows.length === 0) return { kind: "none" };
  const fromAccount = [use.fiveHour, use.weekly]
    .filter((window): window is ClaudePassUseWindow => Boolean(window && window.from.kind === "account_here"))
    .sort((a, b) => b.seenAt - a.seenAt)[0];
  return {
    kind: "seen",
    windows,
    source: fromAccount ? `From ${fromAccount.from.label ?? "this computer"}, ${agoText(fromAccount.seenAt, now)}` : null,
  };
}

export function passTitle(pass: { email: string | null; createdAt: number }, now: number): string {
  return pass.email ?? `Claude pass from ${shortDate(pass.createdAt, now)}`;
}

function stateLine(pass: ReadableCloudPassRow, now: number): PassLine {
  switch (pass.state) {
    case "ended":
      return { text: `Claude ended this pass${pass.endedAt != null ? ` on ${shortDate(pass.endedAt, now)}` : ""}. Renew it or remove it.`, tone: "crit" };
    case "estimate_passed":
      return { text: "Its expected end date has passed. Renew it to be sure.", tone: "warn" };
    case "ending_soon": {
      const days = Math.max(0, Math.round(pass.endsInDays));
      return { text: `Ends in ${days} day${days === 1 ? "" : "s"}`, tone: "warn" };
    }
    default:
      if (pass.expiresAt == null) return { text: "", tone: null };
      return { text: `${pass.expiresAtSource === "claude" ? "Ends on" : "Ends around"} ${shortDate(pass.expiresAt, now)}`, tone: null };
  }
}

const UPLOAD_LINE: Record<"pending" | "refused", string> = {
  pending: "ADE couldn't reach your account yet. The pass is kept on this computer, and ADE sends it on its own.",
  refused: "Your ADE account doesn't take Claude passes yet. ADE keeps the pass on this computer and tries again every hour.",
};

/** The pass cards, in the account's order (newest first, then the rows ADE can't read). `hidden` holds the held Removes. */
export function passCards(args: {
  account: AdeCloudAccountPart;
  cloud: AdeCloudCloudPart;
  passUse: ReadonlyMap<string, ClaudePassUseView>;
  hidden: ReadonlySet<string>;
  now: number;
}): PassCardModel[] {
  const { account, cloud, passUse, hidden, now } = args;
  if (account.state !== "ok") return [];
  const cloudRows = cloud.state === "ok" ? readClaudePasses(cloud.status) : [];
  return readClaudePasses(account.status)
    .filter((pass) => !hidden.has(pass.key))
    .map((pass): PassCardModel => {
      if (pass.unreadable) return { kind: "unreadable", key: pass.key, title: "Claude pass ADE can't read" };
      const made = [
        pass.madeOnLabel ? `Made on ${pass.madeOnLabel}` : "Made",
        dayText(pass.createdAt, now),
      ].join(pass.madeOnLabel ? " · " : " ");
      return {
        kind: "pass",
        key: pass.key,
        title: passTitle(pass, now),
        email: pass.email,
        on: pass.on,
        newChats: pass.newChats,
        ended: pass.state === "ended",
        // Only a pressed account can be unconfirmed; a pass with no email had nothing to check.
        checkLine: pass.check === "unchecked" && pass.email ? "ADE couldn't check this account." : null,
        madeLine: pass.renewedAt != null ? `${made} · Renewed ${dayText(pass.renewedAt, now)}` : made,
        stateLine: stateLine(pass, now),
        renewNow: pass.state !== "active",
        use: passUseModel(joinedPassUse(cloudRows.find((row) => row.key === pass.key), passUse.get(pass.key)), now),
        uploadLine: pass.upload === "account" ? null : UPLOAD_LINE[pass.upload],
      };
    });
}

/** Claude's smart balance on ADE Cloud: the account setting, else what the passes carry (an older brain). */
export function cloudSmartBalance(account: AdeCloudAccountPart): boolean {
  if (account.state !== "ok") return false;
  const fromSetting = account.status.cloud.claude?.smartBalance;
  if (typeof fromSetting === "boolean") return fromSetting;
  return readClaudePasses(account.status).some((pass) => !pass.unreadable && pass.smartBalance);
}

/** The line under the banner: what new cloud chats use now, and why the page shows only the account when it does. */
export function claudePageLine(cards: readonly PassCardModel[], smartBalance: boolean, account: AdeCloudAccountPart, cloud: AdeCloudCloudPart): string {
  const page = adeCloudPageLine(account, cloud);
  const readable = cards.filter((card): card is Extract<PassCardModel, { kind: "pass" }> => card.kind === "pass");
  const on = readable.filter((card) => card.on && !card.ended);
  let lead: string;
  if (account.state === "loading") lead = "";
  else if (cards.length === 0) lead = "Approve a Claude pass so cloud chats can use your Claude plan.";
  else if (readable.length === 0) lead = "ADE couldn't read your Claude pass.";
  else if (readable.every((card) => card.ended)) lead = "Claude ended your pass. Renew it so cloud chats keep working.";
  else if (on.length === 0) lead = "Every pass is off for ADE Cloud.";
  else if (smartBalance) lead = "Smart balance picks a pass for each new chat on ADE Cloud.";
  else {
    const current = on.find((card) => card.newChats) ?? on[0]!;
    lead = `New cloud chats use ${current.title}.`;
  }
  if (page.text === ADE_CLOUD_REACH_LINE) return lead;
  return lead ? `${lead} ${page.text}` : page.text;
}
