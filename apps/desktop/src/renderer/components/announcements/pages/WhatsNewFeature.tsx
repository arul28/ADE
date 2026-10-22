import { useCallback, type CSSProperties, type ReactNode } from "react";
import { useAppStore } from "../../../state/appStore";
import { ADE_TIPS, runTipAction, tipActionAvailable } from "../../../onboarding/adeTips";
import { markTipTried } from "../../../onboarding/situationalSuggestions";
import { useGoTo } from "../../onboarding/spotlight/useGoTo";
import "./whatsNewFeature.css";

/**
 * One "What's new" feature: where it lives, a headline, one sentence, and a
 * recording of the real thing. The recording is the hero; the words stay
 * short. An optional button runs an ADE Tips action, so it goes to the real
 * place and points at it.
 *
 * Recordings are GIFs (a page renders only while it is on screen). Under
 * either reduce-motion switch a still frame shows instead.
 */

export type WhatsNewFeatureProps = {
  close: () => void;
  /** Where the feature lives: its mark and name. */
  place: { icon: ReactNode; name: string };
  headline: string;
  sentence: string;
  media: { gif: string; still: string; width: number; height: number; alt: string };
  /** An ADE Tips entry whose action the button runs, and the button's label. */
  action?: { tipId: string; label: string };
};

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.dataset.motion === "reduced"
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function WhatsNewFeature({ close, place, headline, sentence, media, action }: WhatsNewFeatureProps) {
  const goTo = useGoTo();
  const hasProject = useAppStore((state) => state.project != null);
  const tip = action ? ADE_TIPS.find((entry) => entry.id === action.tipId) : undefined;
  const canRun = Boolean(tip?.action && tipActionAvailable(tip.action));
  const run = useCallback(() => {
    if (!tip?.action) return;
    close();
    markTipTried(tip.id);
    runTipAction(tip.action, goTo, hasProject);
  }, [close, goTo, hasProject, tip]);

  return (
    <article className="ade-wnf">
      <div className="ade-wnf-text">
        <p className="ade-wnf-place">
          <span className="ade-wnf-place-mark" aria-hidden>{place.icon}</span>
          {place.name}
        </p>
        <h2 className="ade-wnf-headline">{headline}</h2>
        <p className="ade-wnf-sentence">{sentence}</p>
        {action && canRun ? (
          <button type="button" className="kit-btn ade-wnf-action" onClick={run}>
            {action.label}
          </button>
        ) : null}
      </div>
      <figure className="ade-wnf-media" style={{ "--wnf-ratio": media.width / media.height } as CSSProperties}>
        <img
          src={reducedMotion() ? media.still : media.gif}
          width={media.width}
          height={media.height}
          alt={media.alt}
          decoding="async"
          draggable={false}
        />
      </figure>
    </article>
  );
}
