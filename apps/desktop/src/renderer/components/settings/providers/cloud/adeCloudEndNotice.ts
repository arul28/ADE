/**
 * The words of the end warning (design §4.5) for the one sign-in that desktop
 * main names in `cloudAccess.read().signInEnd`: a Claude pass, or a key whose
 * provider gave its end date. Pure: no reads, no React.
 */
import type { CloudKeyEnd, CloudSignInEnd } from "../../../../../shared/cloudSignIns";
import { providerGroupLabel, type ProviderGroupKey } from "../../../../../shared/modelCatalog";
import { endsInDaysText, shortDate } from "./adeCloudTime";

export type AdeCloudEndNoticeWords = { title: string; detail: string; action: string };

/** The provider's name for a key's notice. */
export function adeCloudEndProviderName(end: CloudKeyEnd): string {
  return providerGroupLabel(end.provider as ProviderGroupKey) ?? end.provider;
}

/** The others that are due: passes and keys alike, so "sign-ins". */
function moreText(end: CloudSignInEnd): string {
  if (end.more === 0) return "";
  return end.more === 1 ? " 1 more sign-in needs a renew too." : ` ${end.more} more sign-ins need a renew too.`;
}

function keyWords(end: CloudKeyEnd, now: number): AdeCloudEndNoticeWords {
  const name = adeCloudEndProviderName(end);
  const whose = end.email ? ` (${end.email})` : "";
  const more = moreText(end);
  // The key came from the provider's own sign-in: a new sign-in makes a new key.
  const where = end.madeOnLabel ? ` on ${end.madeOnLabel}` : "";
  const fix = `Sign in to ${name} again${where}, or add a new key, so cloud chats keep working.`;
  if (end.state === "ended") {
    return {
      title: `Your ${name} key for ADE Cloud${whose} has ended`,
      detail: `${name} set it to end on ${shortDate(end.expiresAt, now)}. ${fix}${more}`,
      action: "Replace",
    };
  }
  const days = Math.max(0, end.endsInDays);
  return {
    title: days === 0
      ? `Your ${name} key for ADE Cloud${whose} ends today`
      : `Your ${name} key for ADE Cloud${whose} ends in ${endsInDaysText(days)}`,
    detail: `${name} set this end date. ${fix}${more}`,
    action: "Replace",
  };
}

export function adeCloudEndNoticeWords(end: CloudSignInEnd, now: number): AdeCloudEndNoticeWords {
  if (end.kind === "key") return keyWords(end, now);
  const more = moreText(end);
  const whose = end.email ? ` (${end.email})` : "";
  switch (end.state) {
    case "ended":
      return {
        title: `Claude ended your pass for ADE Cloud${whose}`,
        detail: (end.endedAt != null
          ? `It ended on ${shortDate(end.endedAt, now)}. Renew it so cloud chats work again.`
          : "Renew it so cloud chats work again.") + more,
        action: "Renew",
      };
    case "estimate_passed":
      return {
        title: `Your Claude pass for ADE Cloud${whose} may have ended`,
        detail: `Its expected end date has passed. Renew it to be sure cloud chats keep working.${more}`,
        action: "Renew",
      };
    default: {
      const days = Math.max(0, end.endsInDays);
      return {
        title: days === 0
          ? `Your Claude pass for ADE Cloud${whose} ends today`
          : `Your Claude pass for ADE Cloud${whose} ends in ${endsInDaysText(days)}`,
        detail: `Renew it so cloud chats keep working.${more}`,
        action: "Renew",
      };
    }
  }
}
