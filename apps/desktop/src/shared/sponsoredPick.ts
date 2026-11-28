import type { AdeCardPayload } from "./adeCard";
import { isGravityUrl, type CloudSponsoredPick } from "./adeCloud";
import { BRAND } from "./brand";

/**
 * The card an agent's `cloud.recommend` posts in its chat: one Sponsored
 * recommendation from Gravity's Index for a real need the person has. It
 * installs nothing. The person opens the site, or taps Use it, which puts the
 * steps in the prompt box for them to send. A client that doesn't know the
 * variant shows `fallbackText`, which carries the Sponsored label too.
 */
export const SPONSORED_PICK_CARD_VARIANT = "sponsored_pick";

const ROW = { need: "sponsored_need", description: "sponsored_description", url: "sponsored_url", site: "sponsored_site", step: "sponsored_step" } as const;

export type SponsoredPickCardFacts = {
  pickId: string;
  name: string;
  category: string | null;
  description: string;
  need: string;
  /** Gravity's tracked link: the only link the card opens. */
  url: string;
  websiteUrl: string | null;
  steps: string[];
};

export function buildSponsoredPickCard(pick: CloudSponsoredPick, need: string): AdeCardPayload {
  const steps = pick.installSteps.slice(0, 6);
  return {
    cardId: `sponsored-pick:${pick.id}`,
    variant: SPONSORED_PICK_CARD_VARIANT,
    state: "live",
    title: pick.name,
    subtitle: pick.category,
    rows: [
      { key: ROW.need, icon: "info", text: need },
      { key: ROW.description, icon: "info", text: pick.description },
      { key: ROW.url, icon: "info", text: pick.name, detail: pick.url },
      ...(pick.websiteUrl ? [{ key: ROW.site, icon: "info" as const, text: pick.websiteUrl }] : []),
      ...steps.map((step) => ({ key: ROW.step, icon: "info" as const, text: step })),
    ],
    actions: [],
    fallbackText: `Sponsored: ${pick.name}. ${pick.description}${pick.websiteUrl ? ` ${pick.websiteUrl}` : ""} (a recommendation from Gravity, ${BRAND.NAME}'s ad partner; nothing was installed).`,
  };
}

/** The facts a `sponsored_pick` card carries, or null for any other card (or one whose link isn't Gravity's). */
export function sponsoredPickOfCard(card: AdeCardPayload): SponsoredPickCardFacts | null {
  if (card.variant !== SPONSORED_PICK_CARD_VARIANT || !card.cardId.startsWith("sponsored-pick:")) return null;
  const rows = card.rows ?? [];
  const row = (key: string) => rows.find((entry) => entry.key === key) ?? null;
  const url = row(ROW.url)?.detail ?? null;
  if (!isGravityUrl(url)) return null;
  return {
    pickId: card.cardId.slice("sponsored-pick:".length),
    name: card.title,
    category: card.subtitle ?? null,
    description: row(ROW.description)?.text ?? "",
    need: row(ROW.need)?.text ?? "",
    url,
    websiteUrl: row(ROW.site)?.text ?? null,
    steps: rows.filter((entry) => entry.key === ROW.step).map((entry) => entry.text),
  };
}

/** What Use it puts in the prompt box: the person sends it, or edits it first. */
export function sponsoredPickUseText(facts: SponsoredPickCardFacts): string {
  const steps = facts.steps.length ? `\n${facts.steps.map((step) => `- ${step}`).join("\n")}` : "";
  return `Set up ${facts.name} for this.${steps}`;
}
