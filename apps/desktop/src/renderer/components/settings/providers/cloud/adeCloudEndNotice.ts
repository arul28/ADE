/**
 * The words of the end warning (design §4.5) for the one Claude pass that
 * desktop main names in `cloudAccess.read().passEnd`. Pure: no reads, no React.
 */
import type { CloudPassEnd } from "../../../../../shared/cloudSignIns";
import { shortDate } from "./adeCloudSignInModel";

export type AdeCloudEndNoticeWords = { title: string; detail: string };

export function adeCloudEndNoticeWords(end: CloudPassEnd, now: number): AdeCloudEndNoticeWords {
  const more = end.more === 0 ? "" : end.more === 1 ? " 1 more pass needs a renew too." : ` ${end.more} more passes need a renew too.`;
  const whose = end.email ? ` (${end.email})` : "";
  switch (end.state) {
    case "ended":
      return {
        title: `Claude ended your pass for ADE Cloud${whose}`,
        detail: (end.endedAt != null
          ? `It ended on ${shortDate(end.endedAt, now)}. Renew it so cloud chats work again.`
          : "Renew it so cloud chats work again.") + more,
      };
    case "estimate_passed":
      return {
        title: `Your Claude pass for ADE Cloud${whose} may have ended`,
        detail: `Its expected end date has passed. Renew it to be sure cloud chats keep working.${more}`,
      };
    default: {
      const days = Math.max(0, end.endsInDays);
      return {
        title: days === 0
          ? `Your Claude pass for ADE Cloud${whose} ends today`
          : `Your Claude pass for ADE Cloud${whose} ends in ${days} day${days === 1 ? "" : "s"}`,
        detail: `Renew it so cloud chats keep working.${more}`,
      };
    }
  }
}
