import { useEffect, useMemo, useState } from "react";
import { Banner } from "./Banner";
import { useAppBannerEntries, type AppBannerEntry } from "./appBannerStore";
import { FLOATS_OVER_BROWSER_PROPS, floatingLayerBusy } from "../overlayState";

/**
 * Situational suggestions (`useAppBanner(model, { placement: "suggestion" })`)
 * render as one small card in the bottom-right corner, inside the toast
 * viewport, which owns that corner's placement, width and motion.
 *
 * Why there: a suggestion is never urgent. The corner is where ADE already
 * puts things you may glance at and ignore (toasts), it covers no header, tab
 * or composer, and it does not push the page the way a docked banner does.
 * The top-center floating slot is for one-line prompts about something that
 * just happened (a link in the clipboard).
 *
 * One at a time: the highest priority, then the first registered. The rest
 * wait their turn instead of stacking up.
 *
 * Out of the way of modals and hints: the toast corner sits above dialogs (so
 * a toast a dialog raises is seen), but a suggestion must never sit on top of
 * a dialog or the first-run setup, and must not compete with a first-chat
 * hint for attention, so it waits while either is up.
 */

/**
 * Whether a modal or a first-chat hint is up. Both portal into <body>, so
 * watching body's own children (not its subtree) is enough, and it only runs
 * while a suggestion wants to show.
 */
function useModalOpen(watch: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!watch) {
      setOpen(false);
      return;
    }
    const check = () => setOpen(floatingLayerBusy());
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [watch]);
  return open;
}

export function useVisibleAppSuggestion(): AppBannerEntry | null {
  const entries = useAppBannerEntries();
  const top = useMemo(() => {
    let best: AppBannerEntry | null = null;
    for (const entry of entries) {
      if (entry.placement !== "suggestion") continue;
      if (!best || entry.priority < best.priority || (entry.priority === best.priority && entry.order < best.order)) best = entry;
    }
    return best;
  }, [entries]);
  const modalOpen = useModalOpen(top !== null);
  return modalOpen ? null : top;
}

export function AppSuggestionCard({ entry }: { entry: AppBannerEntry }): JSX.Element {
  return (
    <div data-testid="app-suggestion" {...FLOATS_OVER_BROWSER_PROPS} style={{ pointerEvents: "auto" }}>
      <Banner model={entry.model} layout="suggestion" />
    </div>
  );
}
