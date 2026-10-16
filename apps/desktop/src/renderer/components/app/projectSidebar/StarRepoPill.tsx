import { useCallback, useEffect, useRef, useState } from "react";
import { Star } from "@phosphor-icons/react";
import { Banner } from "../../ui/notice";
import { rootAppStoreApi, useRootAppStore } from "../../../state/appStore";
import { usePrefersReducedMotion } from "../../../hooks/usePrefersReducedMotion";
import {
  ADE_GITHUB_REPO_URL,
  STAR_PILL_SNOOZE_THREADS,
  isStarCheckDue,
  isStarPillVisible,
} from "../../../lib/starPill";
import type { GitHubRepoStarState } from "../../../../shared/types";

/** How long "Thanks!" stays up before it fades. */
const THANKS_HOLD_MS = 2_000;
/** Matches the `.ade-star-pill[data-leaving]` opacity transition. */
const THANKS_FADE_MS = 320;

type ThanksPhase = "none" | "showing" | "leaving";

async function readStarState(): Promise<GitHubRepoStarState> {
  try {
    return (await window.ade?.github?.isRepoStarred?.()) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The desktop "Star ADE on GitHub" pill above the sidebar footer. The parent
 * mounts it only on the Work tab of the desktop app; the rules for when it
 * shows live in `lib/starPill.ts`.
 */
export function StarRepoPill() {
  const prefs = useRootAppStore((s) => s.starPill);
  const visible = isStarPillVisible(prefs);
  const reducedMotion = usePrefersReducedMotion();
  const [thanks, setThanks] = useState<ThanksPhase>("none");
  const checkingRef = useRef(false);
  const checkAfterFocusRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const runCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const state = await readStarState();
      // Read fresh: the pill may have been hidden while the request ran.
      const shownWhenAnswered = visibleRef.current;
      rootAppStoreApi.getState().updateStarPill((prev) => ({
        ...prev,
        lastCheckedAt: Date.now(),
        starred: prev.starred || state === "starred",
      }));
      if (state === "starred" && shownWhenAnswered) setThanks("showing");
    } finally {
      checkingRef.current = false;
    }
  }, []);

  // Periodic check: at most every 6 hours, and only while the pill would show.
  useEffect(() => {
    if (!visible) return;
    if (!isStarCheckDue(rootAppStoreApi.getState().starPill, Date.now())) return;
    void runCheck();
  }, [runCheck, visible]);

  // After a click the user is on GitHub; check once when they come back.
  useEffect(() => {
    const onFocus = () => {
      if (!checkAfterFocusRef.current) return;
      checkAfterFocusRef.current = false;
      void runCheck();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [runCheck]);

  useEffect(() => {
    if (thanks === "none") return;
    const timer = window.setTimeout(
      () => setThanks(thanks === "showing" ? "leaving" : "none"),
      thanks === "showing" ? THANKS_HOLD_MS : reducedMotion ? 0 : THANKS_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [reducedMotion, thanks]);

  const openRepo = useCallback(() => {
    checkAfterFocusRef.current = true;
    void window.ade.app.openExternal(ADE_GITHUB_REPO_URL);
  }, []);

  const snooze = useCallback(() => {
    rootAppStoreApi.getState().updateStarPill((prev) => ({
      ...prev,
      snoozedUntilThreadCount: prev.threadsCreated + STAR_PILL_SNOOZE_THREADS,
    }));
  }, []);

  if (thanks !== "none") {
    return (
      <div className="ade-star-pill" data-leaving={thanks === "leaving" ? "true" : undefined}>
        <Banner
          layout="floating"
          testId="star-repo-pill"
          model={{
            id: "star-repo-thanks",
            tone: "accent",
            icon: (
              <span className="ade-star-pill-burst" data-animate={reducedMotion ? undefined : "true"}>
                <Star size={14} weight="fill" />
                {reducedMotion ? null : Array.from({ length: 6 }, (_, index) => (
                  <span key={index} className="ade-star-pill-spark" style={{ ["--spark-turn" as string]: `${index / 6}turn` }} />
                ))}
              </span>
            ),
            title: "Thanks!",
          }}
        />
      </div>
    );
  }

  if (!visible) return null;

  return (
    <div className="ade-star-pill">
      <Banner
        layout="floating"
        testId="star-repo-pill"
        model={{
          id: "star-repo",
          tone: "accent",
          icon: <Star size={14} weight="fill" />,
          ariaLabel: "Star ADE on GitHub",
          title: (
            <button type="button" className="ade-star-pill-link" onClick={openRepo}>
              Star ADE on GitHub
            </button>
          ),
          dismiss: {
            onDismiss: snooze,
            title: `Hide for ${STAR_PILL_SNOOZE_THREADS} new chats`,
            label: "Hide the GitHub star prompt",
          },
        }}
      />
    </div>
  );
}
