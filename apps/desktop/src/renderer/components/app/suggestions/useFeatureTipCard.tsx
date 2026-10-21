import { useEffect, useMemo, useState } from "react";
import { APP_BANNER_PRIORITY, useAppBanner } from "../../ui/notice/appBannerStore";
import { ADE_TIPS, adeTipGroup, runTipAction, tipActionAvailable, tipIndexForDay, type AdeTip } from "../../../onboarding/adeTips";
import { ADE_TIP_SHOTS } from "../../onboarding/tips/adeTipsWall";
import {
  answerTipCard,
  claimTipCard,
  doneTipIds,
  isTipCardShowing,
  suggestionsTestMode,
  useSuggestionRulesVersion,
} from "../../../onboarding/situationalSuggestions";
import { useGoTo } from "../../onboarding/spotlight/useGoTo";

/**
 * Now and then, one of ADE Tips' tips as the corner card: a feature the user
 * has not tried, with the same "Try it" ADE Tips has (go there, ring it).
 *
 * It asks for the card's slot a while into a project session, so the project
 * settles first and any situational suggestion with a real signal gets the
 * slot before it. The rules (`claimTipCard`): the suggestions' one card per
 * launch, cooldown and "never during onboarding", then at most one tip a day,
 * each tip once, and off from ADE Tips. Test mode asks after a few seconds.
 *
 * Cost: one timer per project session; nothing renders until a tip shows.
 */

const ASK_AFTER_MS = 90_000;
const ASK_AFTER_TEST_MS = 4_000;

/** The tip to offer next: today's pick among the ones not tried or shown yet. */
function nextTip(): AdeTip | null {
  const done = doneTipIds();
  const open = ADE_TIPS.filter((tip) => tipActionAvailable(tip.action) && !done.has(tip.id));
  if (!open.length) return null;
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return open[tipIndexForDay(day.getTime(), open.length)] ?? null;
}

export function useFeatureTipCard(enabled: boolean): void {
  const goTo = useGoTo();
  const rulesVersion = useSuggestionRulesVersion();
  const [tip, setTip] = useState<AdeTip | null>(null);

  useEffect(() => {
    if (!enabled || tip) return undefined;
    const ask = () => {
      if (document.hidden) return;
      const next = nextTip();
      if (next && claimTipCard(next.id)) setTip(next);
    };
    const timer = window.setTimeout(ask, suggestionsTestMode() ? ASK_AFTER_TEST_MS : ASK_AFTER_MS);
    return () => window.clearTimeout(timer);
    // `rulesVersion`: an answered card frees the slot (test mode asks again).
  }, [enabled, rulesVersion, tip]);

  const icon = useMemo(() => {
    if (!tip) return null;
    const TipIcon = tip.icon;
    return <TipIcon size={21} weight="duotone" />;
  }, [tip]);

  const showing = tip !== null && enabled && isTipCardShowing(tip.id);
  useAppBanner(
    showing && tip
      ? {
          id: `feature-tip-${tip.id}`,
          tone: "accent",
          icon,
          eyebrow: "Tip",
          // Drawn like its tile in ADE Tips: its group's colour, and its screenshot when it has one.
          hue: adeTipGroup(tip.group).hue,
          art: ADE_TIP_SHOTS[tip.id],
          title: tip.title,
          detail: tip.sentence,
          actions: [
            {
              label: "Try it",
              variant: "solid",
              onClick: () => {
                answerTipCard(tip.id);
                setTip(null);
                if (tip.action) runTipAction(tip.action, goTo, true);
              },
            },
            {
              label: "Not now",
              variant: "secondary",
              title: "Hide it. Every tip stays in ADE Tips.",
              onClick: () => {
                answerTipCard(tip.id);
                setTip(null);
              },
            },
          ],
        }
      : null,
    { placement: "suggestion", priority: APP_BANNER_PRIORITY.suggestion },
  );
}
