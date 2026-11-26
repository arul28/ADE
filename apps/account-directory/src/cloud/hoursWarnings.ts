/**
 * The credits emails (80%, 95% and out), once each a period: the minute tick
 * sends them for accounts with computers (`cron.ts`), and the ten-minute
 * phone check for accounts with a running iPhone (`phones.ts`).
 */

import type { CloudHoursState } from "./contract";
import { sendCloudEmail } from "./email";
import { smallUsesNoHours } from "./sponsoredSmall";
import { phoneAccess } from "./phones";
import { allowancePercentUsed, reportCloudFailure, type AccountRow, type CloudEnv } from "./store";

type WarningText = { all: string; small: string };

/**
 * The emails. Small computers don't use credits, so the text says the
 * bigger sizes stop and Small keeps going (`small`); an account with no free
 * plan, which runs nothing once it is out, or whose Small uses credits (Free
 * without sponsored cards, `smallUsesNoHours`), reads the plain text (`all`).
 * An account that can use the ADE Cloud iPhone reads `phone`: the iPhone
 * draws from the same credits and stops with them.
 */
const WARNINGS: Record<Exclude<CloudHoursState, "none">, {
  column: "warned_zero_at" | "warned_95_at" | "warned_80_at";
  subject: string;
  text: WarningText;
  phone: WarningText;
}> = {
  zero: {
    column: "warned_zero_at",
    subject: "You're out of ADE Cloud credits",
    text: {
      all: "Your ADE Cloud computers have stopped. You can add credits, or wait for your credits to reset.",
      small: "Your computers bigger than Small have stopped. Small computers don't use credits, so they keep working. You can add credits, or wait for your credits to reset.",
    },
    phone: {
      all: "Your ADE Cloud computers and iPhone have stopped. You can add credits, or wait for your credits to reset.",
      small: "Your ADE Cloud iPhone and computers bigger than Small have stopped. Small computers don't use credits, so they keep working. You can add credits, or wait for your credits to reset.",
    },
  },
  warn95: {
    column: "warned_95_at",
    subject: "You've used 95% of your ADE Cloud credits",
    text: {
      all: "You're almost out. When your credits run out, your computers stop until you add credits or they reset.",
      small: "You're almost out. When your credits run out, your computers bigger than Small stop until you add credits or they reset. Small computers keep working.",
    },
    phone: {
      all: "You're almost out. When your credits run out, your computers and iPhone stop until you add credits or they reset.",
      small: "You're almost out. When your credits run out, your iPhone and computers bigger than Small stop until you add credits or they reset. Small computers keep working.",
    },
  },
  warn80: {
    column: "warned_80_at",
    subject: "You've used 80% of your ADE Cloud credits",
    text: {
      all: "Your computers keep working for now. When your credits run out, they stop until you add credits or they reset.",
      small: "Your computers keep working for now. When your credits run out, the ones bigger than Small stop until you add credits or they reset. Small computers keep working.",
    },
    phone: {
      all: "Everything keeps working for now. When your credits run out, your computers and iPhone stop until you add credits or they reset.",
      small: "Everything keeps working for now. When your credits run out, your iPhone and computers bigger than Small stop until you add credits or they reset. Small computers keep working.",
    },
  },
};

/**
 * Sends the account's warning for `state` once a period. The thresholds count
 * the one balance (`credits.ts`), the iPhone's use included.
 */
export async function warnHours(env: CloudEnv, account: AccountRow, state: CloudHoursState, used: number, now: number, allStop: boolean): Promise<void> {
  if (state === "none") return;
  const warning = WARNINGS[state];
  if (account[warning.column] != null) return;
  const stopsAll = allStop || !(await smallUsesNoHours(env, account));
  // Claimed in the write: the minute tick and the phone check may both reach it, and only one sends.
  const claimed = await env.DB.prepare(`update cloud_accounts set ${warning.column} = ?, updated_at = ? where user_id = ? and ${warning.column} is null`).bind(now, now, account.user_id).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return;
  // Of everything the period may use (plan and earned hours), as the warning itself counts.
  const percent = state === "zero" ? 100 : allowancePercentUsed(account, used);
  // The iPhone is named only to someone who can use it; a failed read leaves it out, never the email.
  const phoneOn = await phoneAccess(env, account.user_id).then((read) => read.access === "on", (error: unknown) => {
    reportCloudFailure("cloud.hours_warning_phone_read_failed", { userId: account.user_id, message: error instanceof Error ? error.message : "unknown" });
    return false;
  });
  const text = phoneOn ? warning.phone : warning.text;
  await sendCloudEmail(env, { userId: account.user_id, subject: warning.subject, text: stopsAll ? text.all : text.small, percentUsed: percent });
}

