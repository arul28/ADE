import { useEffect, useMemo, useRef } from "react";
import { APP_BANNER_PRIORITY, useAppBanner } from "../../ui/notice/appBannerStore";
import {
  ADE_SUGGESTIONS,
  forgetPostponedSuggestion,
  postponeSuggestion,
  registerSuggestionKind,
  registerSuggestionStarter,
  type AdeSuggestionId,
} from "../../../onboarding/adeTipsSuggestions";
import {
  answerSuggestion,
  claimSuggestion,
  isSuggestionShowing,
  neverSuggestKind,
  useSuggestionRulesVersion,
} from "../../../onboarding/situationalSuggestions";

/**
 * One situational suggestion, end to end: the card in the bottom-right corner
 * while its signal is there and the shared rules allow it
 * (`situationalSuggestions.ts`), "Not now" filing it into ADE Tips, starting
 * it from Tips, and "Don't suggest again".
 *
 * The caller owns only the signal (`signalKey`, null while there is none) and
 * what the action does. The card's title and line default to the
 * `ADE_SUGGESTIONS` entry the Tips row shows; pass `title`/`detail` to name
 * the specific case ("Claude has 12% left").
 */
export function useSituationalSuggestion({
  id,
  signalKey,
  title,
  detail,
  actionLabel,
  tipsScopeKey,
  context = null,
  start,
  repeatAfterMs,
}: {
  id: AdeSuggestionId;
  /** What this showing is about (a reset window, a lane, a tracker); null while there is no signal. */
  signalKey: string | null;
  title?: string;
  detail?: string;
  actionLabel?: string;
  /** The ADE Tips entry "Not now" files and Tips starts. */
  tipsScopeKey: string;
  /** Where it applies, for the Tips row. */
  context?: string | null;
  /** What the action does; null when it cannot run here (no project open). */
  start: (() => void) | null;
  /** Show the same signal again after this long (default: once). */
  repeatAfterMs?: number;
}): void {
  const definition = ADE_SUGGESTIONS[id];
  const rulesVersion = useSuggestionRulesVersion();
  const startRef = useRef(start);
  startRef.current = start;
  const canStart = start !== null;

  useEffect(() => {
    if (signalKey && canStart) claimSuggestion(id, signalKey, repeatAfterMs);
  }, [canStart, id, repeatAfterMs, rulesVersion, signalKey]);

  // "Don't suggest again" from ADE Tips.
  useEffect(() => registerSuggestionKind(id, { never: () => neverSuggestKind(id) }), [id]);

  // ADE Tips can start a postponed suggestion whenever its action can run.
  useEffect(() => {
    if (!canStart) return undefined;
    return registerSuggestionStarter(id, tipsScopeKey, () => {
      forgetPostponedSuggestion(id, tipsScopeKey);
      startRef.current?.();
    });
  }, [canStart, id, tipsScopeKey]);

  // Built once: a new icon element each render would redraw the card each time.
  const icon = useMemo(() => {
    const SuggestionIcon = definition.icon;
    return <SuggestionIcon size={13} weight="bold" />;
  }, [definition]);

  useAppBanner(
    canStart && signalKey !== null && isSuggestionShowing(id, signalKey)
      ? {
          id: `suggestion-${id}`,
          tone: "accent",
          icon,
          eyebrow: "Suggestion",
          title: title ?? definition.title,
          detail: detail ?? definition.why,
          actions: [
            {
              label: actionLabel ?? definition.actionLabel,
              variant: "solid",
              onClick: () => {
                answerSuggestion(id, signalKey, "started");
                forgetPostponedSuggestion(id, tipsScopeKey);
                startRef.current?.();
              },
            },
            {
              label: "Not now",
              variant: "secondary",
              title: "Hide it. It stays in ADE Tips.",
              onClick: () => {
                answerSuggestion(id, signalKey, "not-now");
                postponeSuggestion({ id, scopeKey: tipsScopeKey, context });
              },
            },
          ],
        }
      : null,
    { placement: "suggestion", priority: APP_BANNER_PRIORITY.suggestion },
  );
}
