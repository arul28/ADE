/**
 * The hours emails (80%, 95% and out), once each a period: the minute tick
 * sends them for accounts with computers (`cron.ts`), and the ten-minute
 * phone check for accounts whose iPhone draws from credits (`phones.ts`).
 */

import { creditsOnFor } from "./credits";
import type { CloudHoursState } from "./contract";
import { sendCloudEmail } from "./email";
import { smallUsesNoHours } from "./gravity";
import { allowancePercentUsed, type AccountRow, type CloudEnv } from "./store";

/**
 * The hours emails. Small computers don't use hours, so the text says the
 * bigger sizes stop and Small keeps going (`small`); an account with no free
 * plan, which runs nothing once it is out, or whose Small uses hours (Free
 * without sponsored cards, `smallUsesNoHours`), reads the plain text (`all`).
 */
const HOURS_WARNINGS: Record<Exclude<CloudHoursState, "none">, {
  column: "warned_zero_at" | "warned_95_at" | "warned_80_at";
  subject: string;
  text: { all: string; small: string };
}> = {
  zero: {
    column: "warned_zero_at",
    subject: "You're out of ADE Cloud hours",
    text: {
      all: "Your ADE Cloud computers have stopped. You can add hours, or wait for your hours to reset.",
      small: "Your computers bigger than Small have stopped. Small computers don't use hours, so they keep working. You can add hours, or wait for your hours to reset.",
    },
  },
  warn95: {
    column: "warned_95_at",
    subject: "You've used 95% of your ADE Cloud hours",
    text: {
      all: "You're almost out. When your hours run out, your computers stop until you add hours or they reset.",
      small: "You're almost out. When your hours run out, your computers bigger than Small stop until you add hours or they reset. Small computers keep working.",
    },
  },
  warn80: {
    column: "warned_80_at",
    subject: "You've used 80% of your ADE Cloud hours",
    text: {
      all: "Your computers keep working for now. When your hours run out, they stop until you add hours or they reset.",
      small: "Your computers keep working for now. When your hours run out, the ones bigger than Small stop until you add hours or they reset. Small computers keep working.",
    },
  },
};

/** The same emails under credits: one balance, which the ADE Cloud iPhone draws from too. */
const CREDITS_WARNINGS: typeof HOURS_WARNINGS = {
  zero: {
    column: "warned_zero_at",
    subject: "You're out of ADE Cloud credits",
    text: {
      all: "Your ADE Cloud computers and iPhone have stopped. You can add credits, or wait for your credits to reset.",
      small: "Your ADE Cloud iPhone and computers bigger than Small have stopped. Small computers don't use credits, so they keep working. You can add credits, or wait for your credits to reset.",
    },
  },
  warn95: {
    column: "warned_95_at",
    subject: "You've used 95% of your ADE Cloud credits",
    text: {
      all: "You're almost out. When your credits run out, your computers and iPhone stop until you add credits or they reset.",
      small: "You're almost out. When your credits run out, your iPhone and computers bigger than Small stop until you add credits or they reset. Small computers keep working.",
    },
  },
  warn80: {
    column: "warned_80_at",
    subject: "You've used 80% of your ADE Cloud credits",
    text: {
      all: "Everything keeps working for now. When your credits run out, your computers and iPhone stop until you add credits or they reset.",
      small: "Everything keeps working for now. When your credits run out, your iPhone and computers bigger than Small stop until you add credits or they reset. Small computers keep working.",
    },
  },
};

/**
 * Sends the account's warning for `state` once a period. Under credits
 * (`credits.ts`) the same thresholds count the one balance, the iPhone's use
 * included, and the email says credits.
 */
export async function warnHours(env: CloudEnv, account: AccountRow, state: CloudHoursState, used: number, now: number, allStop: boolean): Promise<void> {
  if (state === "none") return;
  const words = (await creditsOnFor(env, account.user_id)) ? CREDITS_WARNINGS : HOURS_WARNINGS;
  const warning = words[state];
  if (account[warning.column] != null) return;
  const stopsAll = allStop || !(await smallUsesNoHours(env, account));
  // Claimed in the write: the minute tick and the phone check may both reach it, and only one sends.
  const claimed = await env.DB.prepare(`update cloud_accounts set ${warning.column} = ?, updated_at = ? where user_id = ? and ${warning.column} is null`).bind(now, now, account.user_id).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  // Of everything the period may use (plan and earned hours), as the warning itself counts.
  const percent = state === "zero" ? 100 : allowancePercentUsed(account, used);
  await sendCloudEmail(env, { userId: account.user_id, subject: warning.subject, text: stopsAll ? warning.text.all : warning.text.small, percentUsed: percent });
}

