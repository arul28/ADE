/**
 * The words of the end warning (design §4.5) for the one saved sign-in that
 * desktop main names in `cloudAccess.read().signInEnd`: one ADE can't renew
 * on its own, so it needs the person before it ends. A Claude pass (a
 * long-lived token: only a new pass replaces it), or a key whose provider
 * gave its end date. Each says what stops working, in plain words: that
 * provider's chats and automations on the person's ADE Cloud computers.
 * Pure: no reads, no React.
 */
import type { CloudKeyEnd, CloudSignInEnd } from "../../../../../shared/cloudSignIns";
import { providerGroupLabel, type ProviderGroupKey } from "../../../../../shared/modelCatalog";
import { endsInDaysText, shortDate } from "./adeCloudTime";
import { BRAND } from "../../../../../shared/brand";

export type AdeCloudEndNoticeWords = { title: string; detail: string; action: string };

/** The provider's name for a key's notice. */
export function adeCloudEndProviderName(end: CloudKeyEnd): string {
  return providerGroupLabel(end.provider as ProviderGroupKey) ?? end.provider;
}

/** What stops working when this provider's saved sign-in ends: said the same for a pass and a key. */
function whatStops(name: string): string {
  return `${name} chats and automations on your ${BRAND.CLOUD_NAME} computers`;
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The others that are due: passes and keys alike, so "sign-ins". */
function moreText(end: CloudSignInEnd): string {
  if (end.more === 0) return "";
  return end.more === 1 ? " 1 more saved sign-in needs a renew too." : ` ${end.more} more saved sign-ins need a renew too.`;
}

function keyWords(end: CloudKeyEnd, now: number): AdeCloudEndNoticeWords {
  const name = adeCloudEndProviderName(end);
  const whose = end.email ? ` (${end.email})` : "";
  const more = moreText(end);
  // The key came from the provider's own sign-in: a new sign-in makes a new key.
  const where = end.madeOnLabel ? ` on ${end.madeOnLabel}` : "";
  const fix = `${BRAND.NAME} can't renew a key on its own: sign in to ${name} again${where}, or add a new key.`;
  if (end.state === "ended") {
    return {
      title: `Your ${name} key for ${BRAND.CLOUD_NAME}${whose} has ended`,
      detail: `${capitalized(whatStops(name))} stopped working on ${shortDate(end.expiresAt, now)}, the end date ${name} set. ${fix}${more}`,
      action: "Replace",
    };
  }
  const days = Math.max(0, end.endsInDays);
  return {
    title: days === 0
      ? `Your ${name} key for ${BRAND.CLOUD_NAME}${whose} ends today`
      : `Your ${name} key for ${BRAND.CLOUD_NAME}${whose} ends in ${endsInDaysText(days)}`,
    detail: `${name} set this end date. When it passes, ${whatStops(name)} stop working. ${fix}${more}`,
    action: "Replace",
  };
}

export function adeCloudEndNoticeWords(end: CloudSignInEnd, now: number): AdeCloudEndNoticeWords {
  if (end.kind === "key") return keyWords(end, now);
  const more = moreText(end);
  const whose = end.email ? ` (${end.email})` : "";
  const stops = whatStops("Claude");
  switch (end.state) {
    case "ended":
      return {
        title: `Claude ended your pass for ${BRAND.CLOUD_NAME}${whose}`,
        detail: (end.endedAt != null
          ? `${capitalized(stops)} stopped working on ${shortDate(end.endedAt, now)}. ${BRAND.NAME} can't renew a pass on its own: renew it so they work again.`
          : `${capitalized(stops)} stopped working. ${BRAND.NAME} can't renew a pass on its own: renew it so they work again.`) + more,
        action: "Renew",
      };
    case "estimate_passed":
      return {
        title: `Your Claude pass for ${BRAND.CLOUD_NAME}${whose} may have ended`,
        detail: `Its expected end date has passed. If it ended, ${stops} stop working. Renew it to be sure.${more}`,
        action: "Renew",
      };
    default: {
      const days = Math.max(0, end.endsInDays);
      return {
        title: days === 0
          ? `Your Claude pass for ${BRAND.CLOUD_NAME}${whose} ends today`
          : `Your Claude pass for ${BRAND.CLOUD_NAME}${whose} ends in ${endsInDaysText(days)}`,
        detail: `When it ends, ${stops} stop working. ${BRAND.NAME} can't renew a pass on its own: renew it to keep them working.${more}`,
        action: "Renew",
      };
    }
  }
}
