import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAppStore } from "../../../state/appStore";
import { useAppearanceStore } from "../../../state/appearanceStore";
import { usePrefersReducedMotion } from "../../../hooks/usePrefersReducedMotion";
import { ADE_TIPS, runTipAction, tipActionAvailable } from "../../../onboarding/adeTips";
import { markTipTried } from "../../../onboarding/situationalSuggestions";
import { useGoTo } from "../../onboarding/spotlight/useGoTo";
import "./whatsNewFeature.css";

/**
 * One "What's new" feature: where it lives, a headline, one sentence, and the
 * real thing on the right. The picture is the hero; the words stay short. An
 * optional button runs an ADE Tips action, so it goes to the real place and
 * points at it.
 *
 * The picture is one of:
 * - a GIF recording (a page renders only while it is on screen), with a still
 *   frame under either reduce-motion switch;
 * - two to four screenshots that crossfade (they hold still under reduce
 *   motion; the dots under them switch by hand). One can be a short video: it
 *   plays through once, then the next screenshot fades in;
 * - up to three phone screenshots side by side.
 */

/** A looping screen recording; `still` is its poster and what reduce motion shows. */
type RecordingMedia = { kind?: "recording"; video: string; still: string; width: number; height: number; alt: string };
/** `src` is the picture; with `video`, it is the still shown under reduce motion. */
type Shot = { src: string; alt: string; video?: string };
/** `holdMs` sets how long each screenshot stays, for ones with more to read. */
type ImagesMedia = { kind: "images"; images: readonly Shot[]; width: number; height: number; holdMs?: number };
type PhonesMedia = { kind: "phones"; images: readonly Shot[]; width: number; height: number };

export type WhatsNewFeatureProps = {
  close: () => void;
  /** Where the feature lives: its mark and name. */
  place: { icon: ReactNode; name: string };
  headline: string;
  sentence: string;
  /** Small chips under the sentence: what it works with, each with its own mark. */
  marks?: readonly { icon: ReactNode; label: string }[];
  media: RecordingMedia | ImagesMedia | PhonesMedia;
  /** An ADE Tips entry whose action the button runs, and the button's label. */
  action?: { tipId: string; label: string };
};

/** How long each screenshot holds before the next fades in. */
const CROSSFADE_HOLD_MS = 3_800;

function useReduceMotion(): boolean {
  // ADE's Reduce motion setting or the system's; either one, changed while the page is open, takes effect.
  const appReduceMotion = useAppearanceStore((state) => state.interfacePreferences.reduceMotion);
  const systemReduceMotion = usePrefersReducedMotion();
  return appReduceMotion || systemReduceMotion;
}

export function WhatsNewFeature({ close, place, headline, sentence, marks, media, action }: WhatsNewFeatureProps) {
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
        {marks && marks.length > 0 ? (
          <ul className="ade-wnf-marks">
            {marks.map((mark) => (
              <li key={mark.label} className="ade-wnf-mark">
                <span className="ade-wnf-mark-icon" aria-hidden>{mark.icon}</span>
                {mark.label}
              </li>
            ))}
          </ul>
        ) : null}
        {action && canRun ? (
          <button type="button" className="kit-btn ade-wnf-action" onClick={run}>
            {action.label}
          </button>
        ) : null}
      </div>
      <figure
        className="ade-wnf-media"
        data-kind={media.kind ?? "recording"}
        style={{ "--wnf-ratio": media.width / media.height } as CSSProperties}
      >
        {media.kind === "images" ? (
          <Crossfade media={media} />
        ) : media.kind === "phones" ? (
          <Phones media={media} />
        ) : (
          <Recording media={media} />
        )}
      </figure>
    </article>
  );
}

function Recording({ media }: { media: RecordingMedia }) {
  const reduceMotion = useReduceMotion();
  if (reduceMotion) {
    return (
      <img
        className="ade-wnf-plate"
        src={media.still}
        width={media.width}
        height={media.height}
        alt={media.alt}
        decoding="async"
        draggable={false}
      />
    );
  }
  return (
    <video
      className="ade-wnf-plate"
      src={media.video}
      poster={media.still}
      width={media.width}
      height={media.height}
      aria-label={media.alt}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
    />
  );
}

function Crossfade({ media }: { media: ImagesMedia }) {
  const reduceMotion = useReduceMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = media.images.length;
  const activeIsVideo = Boolean(media.images[index]?.video) && !reduceMotion;
  const next = useCallback(() => setIndex((current) => (current + 1) % count), [count]);

  useEffect(() => {
    // A video moves on when it ends, not on the timer.
    if (reduceMotion || paused || count < 2 || activeIsVideo) return undefined;
    // In the background, move on once ADE is visible again rather than stopping.
    let onVisible: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      if (!document.hidden) return next();
      onVisible = () => {
        if (!document.hidden) next();
      };
      document.addEventListener("visibilitychange", onVisible);
    }, media.holdMs ?? CROSSFADE_HOLD_MS);
    return () => {
      window.clearTimeout(timer);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeIsVideo, count, index, media.holdMs, next, paused, reduceMotion]);

  return (
    <div className="ade-wnf-crossfade" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
      <div className="ade-wnf-plate ade-wnf-stack" style={{ aspectRatio: `${media.width} / ${media.height}` }}>
        {media.images.map((shot, shotIndex) => {
          const active = shotIndex === index;
          return shot.video && !reduceMotion ? (
            <ShotVideo key={shot.src} shot={shot} active={active} loop={count < 2 || paused} onEnded={next} />
          ) : (
            <img
              key={shot.src}
              src={shot.src}
              alt={active ? shot.alt : ""}
              aria-hidden={active ? undefined : true}
              data-active={active ? "true" : undefined}
              decoding="async"
              draggable={false}
            />
          );
        })}
      </div>
      {count > 1 ? (
        <div className="ade-wnf-shots" role="group" aria-label="Screenshots">
          {media.images.map((shot, shotIndex) => (
            <button
              key={shot.src}
              type="button"
              className="ade-wnf-shot-dot"
              aria-label={shot.alt}
              aria-current={shotIndex === index ? "true" : undefined}
              data-active={shotIndex === index ? "true" : undefined}
              onClick={() => setIndex(shotIndex)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A video in the crossfade: it plays from the start each time it fades in, and stops when it fades out. */
function ShotVideo({ shot, active, loop, onEnded }: { shot: Shot; active: boolean; loop: boolean; onEnded: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (active) {
      video.currentTime = 0;
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [active]);
  return (
    <video
      ref={ref}
      src={shot.video}
      aria-label={active ? shot.alt : undefined}
      aria-hidden={active ? undefined : true}
      data-active={active ? "true" : undefined}
      muted
      playsInline
      preload="auto"
      loop={loop}
      onEnded={onEnded}
    />
  );
}

function Phones({ media }: { media: PhonesMedia }) {
  return (
    <div className="ade-wnf-phones" data-count={media.images.length}>
      {media.images.slice(0, 3).map((shot, shotIndex) => (
        <img
          key={shot.src}
          className="ade-wnf-phone"
          data-slot={media.images.length === 3 ? ["left", "center", "right"][shotIndex] : undefined}
          src={shot.src}
          width={media.width}
          height={media.height}
          alt={shot.alt}
          decoding="async"
          draggable={false}
        />
      ))}
    </div>
  );
}
