/**
 * The schedule every desktop sidebar nudge follows (the "Star ADE on GitHub"
 * pill, the "Invite friends" pill): it shows once enough messages were sent,
 * a dismissal hides it for the next few sent messages, and the last allowed
 * dismissal is final. Each pill keeps its own prefs and storage (the star
 * pill's sync through the account, the invite pill's stay on this computer)
 * and adds its own conditions; this holds only the rules over the counters
 * they share. Every counter only moves one way.
 */

export type NudgeCounts = {
  /** Chat messages sent from desktop, counted only while one more can change the pill (`countsMessages`). */
  messagesSent: number;
  /** How many times the pill was dismissed; at the schedule's `maxDismissals` it never returns. */
  dismissCount: number;
  /** Showings already reported as shown, so each showing is reported once. */
  shownReported: number;
  /** Hidden until `messagesSent` reaches this; null when never dismissed. */
  snoozedUntilMessageCount: number | null;
};

export type NudgeShowing = "prompt_first" | "prompt_second" | "prompt_third";

const SHOWINGS: readonly NudgeShowing[] = ["prompt_first", "prompt_second", "prompt_third"];

export type NudgeSchedule = {
  /** Shown by the schedule alone (each pill adds its own conditions). */
  visible(prefs: NudgeCounts): boolean;
  /** Whether one more sent message can still change the pill; past that the counter stays put. */
  countsMessages(prefs: NudgeCounts): boolean;
  /** Which showing this is, for analytics. */
  showing(prefs: NudgeCounts): NudgeShowing;
  /** The next dismissal is the last one: the pill never comes back after it. */
  finalDismissal(prefs: NudgeCounts): boolean;
  /** This showing hasn't been reported as shown yet. */
  shownDue(prefs: NudgeCounts): boolean;
  /** The prefs after this showing was reported. */
  markShown<T extends NudgeCounts>(prefs: T): T;
  /** The prefs after a dismissal: hidden for the next `snoozeMessages` sent messages, or for good. */
  dismissed<T extends NudgeCounts>(prefs: T): T;
  /** The prefs after a sent message (unchanged once the count can't matter). */
  messageSent<T extends NudgeCounts>(prefs: T): T;
};

export function createNudgeSchedule(config: {
  /** A dismissal hides the pill for this many sent messages. */
  snoozeMessages: number;
  /** The dismissal that makes it final (at most 3). */
  maxDismissals: number;
  /** Sent messages before the first showing (0: shows at once). */
  firstAfterMessages: number;
}): NudgeSchedule {
  const { snoozeMessages, maxDismissals, firstAfterMessages } = config;
  const done = (prefs: NudgeCounts) => prefs.dismissCount >= maxDismissals;
  const countsMessages = (prefs: NudgeCounts) => {
    if (done(prefs)) return false;
    if (prefs.snoozedUntilMessageCount == null) return prefs.messagesSent < firstAfterMessages;
    return prefs.messagesSent < prefs.snoozedUntilMessageCount;
  };
  return {
    visible: (prefs) => {
      if (done(prefs) || prefs.messagesSent < firstAfterMessages) return false;
      return prefs.snoozedUntilMessageCount == null || prefs.messagesSent >= prefs.snoozedUntilMessageCount;
    },
    countsMessages,
    showing: (prefs) => SHOWINGS[Math.max(0, Math.min(prefs.dismissCount, maxDismissals - 1, SHOWINGS.length - 1))]!,
    finalDismissal: (prefs) => prefs.dismissCount >= maxDismissals - 1,
    shownDue: (prefs) => prefs.shownReported <= prefs.dismissCount,
    markShown: (prefs) => ({ ...prefs, shownReported: prefs.dismissCount + 1 }),
    dismissed: (prefs) => ({
      ...prefs,
      dismissCount: prefs.dismissCount + 1,
      snoozedUntilMessageCount: prefs.messagesSent + snoozeMessages,
    }),
    messageSent: (prefs) => (countsMessages(prefs) ? { ...prefs, messagesSent: prefs.messagesSent + 1 } : prefs),
  };
}
