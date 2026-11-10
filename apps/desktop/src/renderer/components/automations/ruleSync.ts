import type { Icon } from "@phosphor-icons/react";
import { ArrowsLeftRight, ChatCircle, CloudArrowUp, CloudCheck, CloudSlash } from "@phosphor-icons/react";
import type { AutomationRuleSummary } from "../../../shared/types";

/**
 * Where a rule lives and who runs it, in one short line, for the rule row's
 * tooltip and the "Runs on" field. Every rule that follows the account shows
 * on each computer with the repository and runs on one; a rule kept on this
 * computer says why.
 */
export type RuleSyncLine = {
  icon: Icon;
  /** One short line. */
  label: string;
  /** The longer explanation, for a tooltip. */
  detail: string;
  /** `quiet` is the normal state; `notice` is worth a glance (it is not syncing). */
  tone: "quiet" | "notice";
};

type SyncFields = Pick<AutomationRuleSummary, "source" | "home" | "localReason" | "homeStartsAt" | "runsHere">;

/** True for a rule that follows the account: every machine with the repository lists it. */
export function followsAccount(rule: Pick<AutomationRuleSummary, "source" | "home">): boolean {
  return rule.source === "account" && Boolean(rule.home);
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The line for a saved rule, or null when there is nothing to say (an ordinary rule on a host with no account). */
export function ruleSyncLine(rule: SyncFields, now = Date.now()): RuleSyncLine | null {
  const home = rule.runsHere ? "this computer" : rule.home?.name ?? "another computer";
  if (followsAccount(rule)) {
    const startsAt = rule.homeStartsAt ? Date.parse(rule.homeStartsAt) : Number.NaN;
    if (rule.runsHere && Number.isFinite(startsAt) && startsAt > now) {
      return {
        icon: ArrowsLeftRight,
        label: `Moving here · starts by ${shortTime(rule.homeStartsAt!)}`,
        detail: "This computer waits a moment so the computer that ran it before has stopped. Run now works already.",
        tone: "quiet",
      };
    }
    return {
      icon: CloudCheck,
      label: `Synced · runs only on ${home}`,
      detail: `Saved in your ADE account, so every computer with this repository shows it. Only ${home} runs it.${rule.runsHere ? "" : " Change \"Runs on\" to move it."}`,
      tone: "quiet",
    };
  }
  switch (rule.localReason) {
    case "chat":
      return {
        icon: ChatCircle,
        label: "Kept with its chat on this computer",
        detail: "It belongs to one chat, and that chat lives on this computer.",
        tone: "quiet",
      };
    case "no-remote":
      return {
        icon: CloudSlash,
        label: "Only on this computer · no Git remote",
        detail: "Automations sync per repository. Add a remote so other computers can match this project.",
        tone: "notice",
      };
    case "too-large":
      return {
        icon: CloudSlash,
        label: "Only on this computer · too large to sync",
        detail: "A synced automation can hold 16 KB. Shorten its prompt or steps to sync it.",
        tone: "notice",
      };
    case "signed-out":
      return {
        icon: CloudArrowUp,
        label: "Saved here · syncs when you sign in",
        detail: "Changed while signed out of ADE. It goes to your account when you sign in.",
        tone: "notice",
      };
    case "other-account":
      return {
        icon: CloudArrowUp,
        label: "Saved for another ADE account",
        detail: "Changed while another account was signed in. It syncs when that account signs in again.",
        tone: "notice",
      };
    case "pending":
      return {
        icon: CloudArrowUp,
        label: "Syncing to your ADE account…",
        detail: "It shows on your other computers once this one has synced.",
        tone: "quiet",
      };
    default:
      return null;
  }
}

/**
 * Why Run now and History cannot reach a rule from this window, or null.
 * History lives on the computer that runs the rule.
 */
export function ruleElsewhereReason(rule: Pick<AutomationRuleSummary, "runsHere" | "home" | "needsNewerAde" | "source">): string | null {
  if (rule.needsNewerAde) return "Made with a newer ADE. Update ADE on this computer to run it here.";
  if (followsAccount(rule) && rule.runsHere === false) {
    return `Runs on ${rule.home!.name}, which this window isn't connected to.`;
  }
  return null;
}
