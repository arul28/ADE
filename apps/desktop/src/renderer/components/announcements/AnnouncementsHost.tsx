import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";
import { useAppStore } from "../../state/appStore";
import { onboardingSettledBeforeThisLaunch } from "../../onboarding/onboardingProgress";
import { floatingLayerBusy, launchGateOpen } from "../ui/overlayState";
import { ANNOUNCEMENT_PAGES, type AnnouncementPageDef } from "./announcementPages";
import { dueAnnouncements, markAnnouncementSeen, useSeenAnnouncements } from "./announcementSeen";
import "./announcements.css";

/**
 * The "What's new" modal. Shows the pages this computer has not seen
 * (`announcementPages.ts`), one at a time, inside a project only — never on
 * Home — and only when nothing else wants the user's attention:
 *
 * - onboarding is not running, and finished (or was skipped) before this app
 *   launch, so a brand-new user meets these on a later visit, not mid-setup;
 * - no dialog, setup screen or tour card is up;
 * - the project has been open a few seconds.
 *
 * A page counts as seen once it is on screen. Help › What's new and the
 * command palette reopen every page (`openWhatsNew`).
 *
 * Cost: with nothing due (the usual case) this renders nothing and holds one
 * storage subscription. With pages due it checks the conditions every few
 * seconds until it shows, then stops.
 */

const OPEN_EVENT = "ade:open-whats-new";
/** The project settles before anything shows over it. */
const SETTLE_MS = 4_000;
const CHECK_INTERVAL_MS = 3_000;

/** Opens every "What's new" page (Help menu, command palette). */
export function openWhatsNew(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function AnnouncementsHost() {
  const seen = useSeenAnnouncements();
  const due = useMemo(() => dueAnnouncements(seen), [seen]);
  const inProject = useAppStore((state) => Boolean(state.project) && !state.showWelcome);
  const [pages, setPages] = useState<readonly AnnouncementPageDef[] | null>(null);
  const [shownThisLaunch, setShownThisLaunch] = useState(false);

  useEffect(() => {
    const open = () => setPages(ANNOUNCEMENT_PAGES);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);

  // Wait for a quiet moment inside a project, once per launch.
  const waiting = !pages && !shownThisLaunch && inProject && due.length > 0;
  useEffect(() => {
    if (!waiting) return undefined;
    const since = Date.now();
    const check = () => {
      if (document.hidden || Date.now() - since < SETTLE_MS) return;
      if (!onboardingSettledBeforeThisLaunch() || floatingLayerBusy() || launchGateOpen()) return;
      setShownThisLaunch(true);
      setPages(dueAnnouncements());
    };
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [waiting]);

  const close = useCallback(() => setPages(null), []);
  if (!pages?.length) return null;
  return <AnnouncementsModal pages={pages} onClose={close} />;
}

function AnnouncementsModal({ pages, onClose }: { pages: readonly AnnouncementPageDef[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const page = pages[Math.min(index, pages.length - 1)]!;
  const last = index >= pages.length - 1;

  // On screen means seen; pages closed before they were reached stay due.
  useEffect(() => {
    markAnnouncementSeen(page);
  }, [page]);

  const Page = page.Page;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`What's new: ${page.title}`}
      hideHeader
      hideClose
      width={1080}
      maxHeight="min(90vh, 900px)"
      bodyPadding={false}
      panelClassName="ade-whats-new"
      testId="whats-new"
      footer={(
        <div className="ade-whats-new-foot">
          {pages.length > 1 ? (
            <div className="ade-whats-new-dots" aria-label={`Page ${index + 1} of ${pages.length}`}>
              {pages.map((entry, entryIndex) => (
                <button
                  key={entry.id}
                  type="button"
                  className="ade-whats-new-dot"
                  data-active={entryIndex === index ? "true" : undefined}
                  aria-label={entry.title}
                  aria-current={entryIndex === index ? "step" : undefined}
                  onClick={() => setIndex(entryIndex)}
                />
              ))}
            </div>
          ) : (
            <span />
          )}
          <div className="ade-whats-new-buttons">
            {index > 0 ? (
              <button type="button" className="kit-btn kit-btn-ghost" onClick={() => setIndex(index - 1)}>
                <ArrowLeft size={12} weight="bold" aria-hidden />
                Back
              </button>
            ) : null}
            <button
              type="button"
              className="kit-btn kit-btn-primary"
              autoFocus
              onClick={() => (last ? onClose() : setIndex(index + 1))}
            >
              {last ? "Got it" : "Next"}
              {last ? null : <ArrowRight size={12} weight="bold" aria-hidden />}
            </button>
          </div>
        </div>
      )}
    >
      <button type="button" className="kit-icon-btn ade-whats-new-close" aria-label="Close" onClick={onClose}>
        <X size={13} weight="bold" />
      </button>
      <Suspense fallback={<div className="ade-whats-new-loading" />}>
        <Page key={page.id} close={onClose} />
      </Suspense>
    </Dialog>
  );
}
