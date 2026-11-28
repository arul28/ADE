import { useEffect, useMemo, useRef, useState } from "react";
import { APP_BANNER_PRIORITY, useAppBanner } from "../../ui/notice/appBannerStore";
import { adeTipGroup, machineTipOrder, runTipAction, tipOfferedAsCard, type AdeTip } from "../../../onboarding/adeTips";
import {
  answerTipCard,
  claimTipCard,
  doneTipIds,
  isTipCardShowing,
  nextTipCardAt,
  suggestionsTestMode,
  useSuggestionRulesVersion,
} from "../../../onboarding/situationalSuggestions";
import { useGoTo } from "../../onboarding/spotlight/useGoTo";
import { BRAND } from "../../../../shared/brand";

/**
 * Now and then, one of ADE Tips' tips as the corner card: a feature the user
 * has not tried, with the same "Try it" ADE Tips has (go there, ring it).
 *
 * It asks for the corner a while into a project session, so the project
 * settles first and a situational suggestion with a real signal gets it
 * first, then again whenever the next tip is allowed (`nextTipCardAt`: up to
 * two a week, two days apart, within the shared unasked budget). The rest of the rules are `claimTipCard`'s.
 * It never asks or shows while an agent works in the open project, nor for a
 * short while after the last turn ends (`useAgentBusy`). Test mode asks after
 * a few seconds.
 *
 * Cost: one pending timer while a project is open; nothing renders until a tip shows.
 */

const ASK_AFTER_MS = 90_000;
const ASK_AFTER_TEST_MS = 4_000;
/** How long the project stays quiet after a turn before a tip may ask. */
const QUIET_AFTER_TURN_MS = 30_000;

/**
 * True while an agent works in the project and for a quiet while after its
 * last turn ends, so a tip does not cover the composer while the user reads
 * the answer.
 */
function useAgentBusy(agentWorking: boolean): boolean {
  const [quiet, setQuiet] = useState(false);
  const wasWorkingRef = useRef(agentWorking);
  useEffect(() => {
    const turnEnded = wasWorkingRef.current && !agentWorking;
    wasWorkingRef.current = agentWorking;
    if (!turnEnded) return undefined;
    setQuiet(true);
    const timer = window.setTimeout(() => setQuiet(false), QUIET_AFTER_TURN_MS);
    return () => window.clearTimeout(timer);
  }, [agentWorking]);
  return agentWorking || quiet;
}

/** The tip to offer next: the first in this computer's random order not tried or shown yet. */
function nextTip(): AdeTip | null {
  const done = doneTipIds();
  return machineTipOrder().find((tip) => tipOfferedAsCard(tip) && !done.has(tip.id)) ?? null;
}

export function useFeatureTipCard(enabled: boolean, agentWorking: boolean): void {
  const goTo = useGoTo();
  const rulesVersion = useSuggestionRulesVersion();
  const [tip, setTip] = useState<AdeTip | null>(null);
  /** When this project session began: the first ask waits for it to settle. */
  const sessionStartRef = useRef(0);
  const [retry, setRetry] = useState(0);
  const busy = useAgentBusy(agentWorking);

  useEffect(() => {
    if (!enabled) {
      sessionStartRef.current = 0;
      return undefined;
    }
    const now = Date.now();
    if (!sessionStartRef.current) sessionStartRef.current = now;
    if (tip || busy) return undefined;
    const allowedAt = nextTipCardAt(now);
    if (allowedAt == null) return undefined;
    const settle = sessionStartRef.current + (suggestionsTestMode() ? ASK_AFTER_TEST_MS : ASK_AFTER_MS);
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisible);
      setRetry((value) => value + 1);
    };
    const ask = () => {
      // Hidden: ask again once the window is back in view.
      if (document.hidden) {
        document.addEventListener("visibilitychange", onVisible);
        return;
      }
      const next = nextTip();
      if (next && claimTipCard(next.id)) setTip(next);
    };
    const timer = window.setTimeout(ask, Math.max(0, settle - now, allowedAt - now));
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `rulesVersion`: an answer or a suggestion changes when the next tip may come.
  }, [busy, enabled, retry, rulesVersion, tip]);

  const icon = useMemo(() => {
    if (!tip) return null;
    const TipIcon = tip.icon;
    return <TipIcon size={21} weight="duotone" />;
  }, [tip]);

  // A card already up steps aside while an agent works, and comes back once the project is quiet.
  const showing = tip !== null && enabled && !busy && isTipCardShowing(tip.id);
  useAppBanner(
    showing && tip
      ? {
          id: `feature-tip-${tip.id}`,
          tone: "accent",
          icon,
          // No eyebrow: the title sits beside the icon, so the card wastes no row on a label.
          eyebrow: null,
          // Drawn like its tile in ADE Tips: its group's colour, and its screenshot when it has one, large for a large tile.
          hue: adeTipGroup(tip.group).hue,
          art: tip.shot ? { ...tip.shot, large: tip.size === "screen" } : undefined,
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
              title: `Hide it. Every tip stays in ${BRAND.NAME} Tips.`,
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
