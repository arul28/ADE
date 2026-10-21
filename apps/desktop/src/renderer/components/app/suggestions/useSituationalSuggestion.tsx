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
  neverSuggestScope,
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
 *
 * "Don't suggest again" (from Tips) turns the kind off everywhere, or only
 * for `scopeKey` when the kind's definition says `neverPer: "scope"` (the
 * lane template: per project). How often a signal may show again is the
 * definition's `repeatAfterMs`.
 */
export function useSituationalSuggestion({
  id,
  signalKey,
  title,
  detail,
  actionLabel,
  scopeKey,
  context = null,
  start,
  onNever,
  busy = false,
}: {
  id: AdeSuggestionId;
  /** What this showing is about (a reset window, a lane, a tracker); null while there is no signal. */
  signalKey: string | null;
  title?: string;
  detail?: string;
  actionLabel?: string;
  /** The ADE Tips entry "Not now" files and Tips starts; null while there is none (no project), which also means it cannot start. */
  scopeKey: string | null;
  /** Where it applies, for the Tips row. */
  context?: string | null;
  /** What the action does; null when it cannot run here (no project open). */
  start: (() => void) | null;
  /** Runs when the user says "Don't suggest again" from Tips (analytics). */
  onNever?: () => void;
  /** The action is under way: the card shows it working. */
  busy?: boolean;
}): void {
  const definition = ADE_SUGGESTIONS[id];
  const rulesVersion = useSuggestionRulesVersion();
  const startRef = useRef(start);
  startRef.current = start;
  const onNeverRef = useRef(onNever);
  onNeverRef.current = onNever;
  const canStart = start !== null && scopeKey !== null;

  useEffect(() => {
    if (signalKey && canStart) claimSuggestion(id, signalKey, scopeKey);
  }, [canStart, id, rulesVersion, scopeKey, signalKey]);

  // "Don't suggest again" from ADE Tips, for this scope or (per kind) any one.
  const neverPerScope = definition.neverPer === "scope";
  useEffect(() => registerSuggestionKind(id, {
    never: (neverScopeKey) => {
      onNeverRef.current?.();
      if (neverPerScope) neverSuggestScope(id, neverScopeKey);
      else neverSuggestKind(id);
    },
  }), [id, neverPerScope]);

  // ADE Tips can start a postponed suggestion whenever its action can run.
  useEffect(() => {
    if (!canStart || scopeKey === null) return undefined;
    return registerSuggestionStarter(id, scopeKey, () => {
      forgetPostponedSuggestion(id, scopeKey);
      startRef.current?.();
    });
  }, [canStart, id, scopeKey]);

  // Built once: a new icon element each render would redraw the card each time.
  const icon = useMemo(() => {
    const SuggestionIcon = definition.icon;
    return <SuggestionIcon size={21} weight="duotone" />;
  }, [definition]);

  useAppBanner(
    canStart && scopeKey !== null && signalKey !== null && isSuggestionShowing(id, signalKey)
      ? {
          id: `suggestion-${id}`,
          tone: "accent",
          icon,
          busy,
          eyebrow: "Suggestion",
          title: title ?? definition.title,
          detail: detail ?? definition.why,
          actions: [
            {
              label: actionLabel ?? definition.actionLabel,
              variant: "solid",
              onClick: () => {
                answerSuggestion(id, signalKey, "started");
                forgetPostponedSuggestion(id, scopeKey);
                startRef.current?.();
              },
            },
            {
              label: "Not now",
              variant: "secondary",
              title: "Hide it. It stays in ADE Tips.",
              onClick: () => {
                answerSuggestion(id, signalKey, "not-now");
                postponeSuggestion({ id, scopeKey, context });
              },
            },
          ],
        }
      : null,
    { placement: "suggestion", priority: APP_BANNER_PRIORITY.suggestion },
  );
}
