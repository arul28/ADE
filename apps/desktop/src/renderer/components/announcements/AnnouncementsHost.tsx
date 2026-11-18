import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, X } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";
import { useAppStore } from "../../state/appStore";
import { selectEffectiveThemeId, useAppearanceStore } from "../../state/appearanceStore";
import { resolveTheme, resolveThemeById } from "../../../shared/theme";
import { bundledReleaseNotes } from "../../../shared/bundledReleaseNotes";
import type { UpdateInterruptedChat } from "../../../shared/types";
import { useActiveScene } from "../../scene/useScene";
import { backdropThemeFromScene } from "../../scene/scenePalette";
import { onboardingSettledBeforeThisLaunch } from "../../onboarding/onboardingProgress";
import { editingTextNow, floatingLayerBusy, launchGateOpen } from "../ui/overlayState";
import type { AnnouncementPageDef } from "./announcementPages";
import {
  allAnnouncements,
  dueAnnouncements,
  inProjectShowingAllowed,
  markAnnouncementSeen,
  markShowing,
  useSeenAnnouncements,
} from "./announcementSeen";
import { reconcileSeenAnnouncements, useAnnouncementSeenSync } from "./announcementSeenSync";
import { releaseNotesDigest, type ReleaseNotesDigest } from "./releaseNotesDigest";
import { ReleaseNotesPage } from "./ReleaseNotesPage";
import "./announcements.css";
import { AdeWordmark, useAdeWordmarkSrc } from "../ui/AdeWordmark";
import type { ScreenBox } from "../ui/LiquidGlassLogoReveal";
import { afterBootSplash, bootSplashLogoBox } from "../app/BootSplashReveal";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useWindowInFront } from "../../hooks/useWindowInFront";
import { useArrivalDialogReady, WhatsNewLogoFlight } from "./WhatsNewArrival";
import {
  attachWhatsNewHost,
  WHATS_NEW_AFTER_UPDATE_EVENT,
  WHATS_NEW_OPEN_EVENT,
  type AfterUpdateDetail,
} from "./whatsNewEvents";

/**
 * The "What's new" modal. It opens three ways:
 *
 * - **After an update** this computer installed itself (not one pressed on
 *   another machine): on the first launch of the new version, on whatever
 *   screen ADE opens to. Up to two unseen catalogue pages, then "And more",
 *   the release notes since the version it came from. AutoUpdateControl asks
 *   for it (`openWhatsNewAfterUpdate`) in place of its old notice. It waits
 *   for the boot splash to go, then arrives: the logo flies from the splash
 *   into the header while the window opens around it (`WhatsNewArrival`).
 *   If the person typed or clicked since launch, or is writing (a focused
 *   field with text, a terminal, an IME composition), it waits for a quiet
 *   moment like the in-project showing, and the logo then rises in the middle
 *   of the window instead.
 *   The other two ways open with the plain dialog fade.
 * - **Inside a project**, by itself: up to two unseen catalogue pages, at
 *   most once a week (an after-update showing counts), never in a new
 *   account's first three days or on a day something else unasked showed
 *   (`unaskedBudget.ts`), and only when nothing
 *   else wants the user's attention — onboarding finished or was skipped
 *   before this launch, no dialog, setup screen or tour card is up, the
 *   project has been open a few seconds, nothing was typed or clicked for
 *   8 s, and the person is not writing (a focused field that holds text, a
 *   focused terminal, or an IME composition). An empty focused composer does
 *   not hold it: ADE focuses the composer by itself.
 * - **Help › What's new** or the command palette: every catalogue page,
 *   newest first, then this version's notes.
 *
 * A showing that opens by itself focuses the panel, not a button, so a key
 * meant for the work behind it (an Enter) does nothing.
 *
 * A catalogue page counts as seen once it is on screen, whichever way it
 * opened, and never shows by itself again (`announcementSeen.ts`), on this
 * computer or anywhere else the account is used (`announcementSeenSync.ts`).
 * A page added before the account was created never shows by itself.
 *
 * Cost: with nothing due (the usual case) this renders nothing and holds one
 * storage subscription. With pages due it checks the conditions every few
 * seconds until it shows, then stops.
 */

/** The project settles before anything shows over it. */
const SETTLE_MS = 4_000;
const CHECK_INTERVAL_MS = 3_000;
/** The person must not have typed or clicked for this long before the modal may open over their work. */
const INPUT_QUIET_MS = 8_000;

type NotesPage = {
  digest: ReleaseNotesDigest | null;
  resumedChats: readonly UpdateInterruptedChat[];
  changelogUrl: string | null;
  githubReleaseUrl: string | null;
};

/** After an update: the version it brought, and the splash's last logo box to fly from. */
type Arrival = { version: string; from: ScreenBox | null };

type Showing = {
  pages: readonly AnnouncementPageDef[];
  notes: NotesPage | null;
  /** Opened by itself (after an update, or in a project), not from Help. */
  unasked?: boolean;
  onClose?: () => void;
  /** After an update: the logo flies in, from the splash's last logo box when there is one. */
  arrival?: Arrival;
};

export function AnnouncementsHost() {
  useAnnouncementSeenSync();
  const seen = useSeenAnnouncements();
  const due = useMemo(() => dueAnnouncements(seen), [seen]);
  const inProject = useAppStore((state) => Boolean(state.project) && !state.showWelcome);
  const [showing, setShowing] = useState<Showing | null>(null);
  const [shownThisLaunch, setShownThisLaunch] = useState(false);

  useEffect(() => {
    const openAll = () => {
      const version = bundledReleaseNotes.version;
      const digest = releaseNotesDigest(version);
      // The after-update showing stays: replacing it would drop its onClose, and the next launch would show it again.
      setShowing((current) => current?.onClose ? current : {
        pages: allAnnouncements(),
        notes: digest ? { digest, resumedChats: [], changelogUrl: null, githubReleaseUrl: null } : null,
      });
    };
    let cancelArrival = () => {};
    const openAfterUpdate = (event: Event) => {
      const detail = (event as CustomEvent<AfterUpdateDetail>).detail;
      if (!detail) return;
      markShowing();
      setShownThisLaunch(true);
      cancelArrival();
      const inputWatch = watchInput();
      // The account's copy is read while the splash plays, and the pages are
      // picked once it is in (or given up on), like the in-project showing.
      const accountRead = reconcileSeenAnnouncements();
      let cancelled = false;
      let quietTimer: number | null = null;
      const show = (from: ScreenBox | null) => {
        inputWatch.stop();
        setShowing({
          pages: dueAnnouncements(),
          notes: {
            digest: releaseNotesDigest(detail.version, detail.fromVersion),
            resumedChats: detail.resumedChats,
            changelogUrl: detail.changelogUrl,
            githubReleaseUrl: detail.githubReleaseUrl,
          },
          onClose: detail.onClose,
          arrival: { version: detail.version, from },
          unasked: true,
        });
      };
      const cancelSplash = afterBootSplash(() => {
        const from = bootSplashLogoBox();
        void accountRead.then(() => {
          if (cancelled) return;
          // Straight from the splash only when nobody has touched ADE yet.
          if (inputWatch.lastInputAt() === null && quietNow(inputWatch, null)) return show(from);
          // Otherwise wait for a quiet moment, then rise in the middle.
          quietTimer = window.setInterval(() => {
            if (cancelled || !quietNow(inputWatch, inputWatch.lastInputAt())) return;
            if (quietTimer != null) window.clearInterval(quietTimer);
            quietTimer = null;
            show(null);
          }, CHECK_INTERVAL_MS);
        });
      });
      cancelArrival = () => {
        cancelled = true;
        cancelSplash();
        inputWatch.stop();
        if (quietTimer != null) window.clearInterval(quietTimer);
      };
    };
    window.addEventListener(WHATS_NEW_OPEN_EVENT, openAll);
    window.addEventListener(WHATS_NEW_AFTER_UPDATE_EVENT, openAfterUpdate);
    // Requests made before this loaded arrive now.
    const detach = attachWhatsNewHost();
    return () => {
      detach();
      window.removeEventListener(WHATS_NEW_OPEN_EVENT, openAll);
      window.removeEventListener(WHATS_NEW_AFTER_UPDATE_EVENT, openAfterUpdate);
      cancelArrival();
    };
  }, []);

  // Wait for a quiet moment inside a project, once per launch and once a week.
  const waiting = !showing && !shownThisLaunch && inProject && due.length > 0;
  useEffect(() => {
    if (!waiting) return undefined;
    const since = Date.now();
    const input = watchInput();
    // Pages seen on another computer or in ADE Web are not due here: the
    // account's copy is read (or given up on) before anything shows.
    let accountRead = false;
    void reconcileSeenAnnouncements().then(() => {
      accountRead = true;
    });
    const check = () => {
      if (!accountRead || Date.now() - since < SETTLE_MS) return;
      if (!quietNow(input, input.lastInputAt() ?? since)) return;
      // Onboarding that was not done before this launch cannot become so
      // until the next one: this launch's chance is gone, so the check stops.
      if (!onboardingSettledBeforeThisLaunch()) {
        setShownThisLaunch(true);
        return;
      }
      if (launchGateOpen()) return;
      setShownThisLaunch(true);
      if (!inProjectShowingAllowed()) return;
      const pages = dueAnnouncements();
      if (pages.length === 0) return;
      markShowing();
      setShowing({ pages, notes: null, unasked: true });
    };
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      input.stop();
    };
  }, [waiting]);

  const showingRef = useRef(showing);
  showingRef.current = showing;
  const close = useCallback(() => {
    showingRef.current?.onClose?.();
    setShowing(null);
  }, []);
  if (!showing || (showing.pages.length === 0 && !showing.notes)) return null;
  return (
    <AnnouncementsModal
      pages={showing.pages}
      notes={showing.notes}
      arrival={showing.arrival ?? null}
      unasked={showing.unasked === true}
      onClose={close}
    />
  );
}

type InputWatch = {
  /** The last key, click or IME event; null while there was none. */
  lastInputAt: () => number | null;
  /** An IME composition is open (it can last longer than the quiet spell). */
  composing: () => boolean;
  stop: () => void;
};

/** Watches for the person's own input (a key, a click, an IME composition) until stopped. */
function watchInput(): InputWatch {
  let lastInputAt: number | null = null;
  let composing = false;
  const noteInput = () => { lastInputAt = Date.now(); };
  // An IME composition counts as typing from its first key, before any keydown commits text.
  const onCompositionStart = () => { composing = true; noteInput(); };
  const onCompositionEnd = () => { composing = false; noteInput(); };
  const options = { capture: true, passive: true } as const;
  window.addEventListener("keydown", noteInput, options);
  window.addEventListener("pointerdown", noteInput, options);
  window.addEventListener("compositionstart", onCompositionStart, options);
  window.addEventListener("compositionend", onCompositionEnd, options);
  let stopped = false;
  return {
    lastInputAt: () => lastInputAt,
    composing: () => composing,
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener("keydown", noteInput, { capture: true });
      window.removeEventListener("pointerdown", noteInput, { capture: true });
      window.removeEventListener("compositionstart", onCompositionStart, { capture: true });
      window.removeEventListener("compositionend", onCompositionEnd, { capture: true });
    },
  };
}

/**
 * A moment the modal may open over the person's work: the window shows, no
 * dialog or hint is up, the person is not writing (a focused field with text,
 * a focused terminal, an open IME composition), and nothing was typed or
 * clicked for `INPUT_QUIET_MS` (`since` null: nothing yet). An empty focused
 * composer may show it.
 */
function quietNow(input: InputWatch, since: number | null): boolean {
  if (document.hidden || floatingLayerBusy() || editingTextNow() || input.composing()) return false;
  return since === null || Date.now() - since >= INPUT_QUIET_MS;
}

/**
 * The four colours the modal's glow floats in: the current background
 * picture's ramp (the same one the window mesh paints), or the theme's own
 * accents when there is no picture, as in Settings › Appearance's preview.
 */
function useGlowColors(): CSSProperties {
  const scene = useActiveScene();
  const mode = useAppStore((state) => state.theme);
  const themeId = useAppearanceStore(selectEffectiveThemeId);
  const customThemes = useAppearanceStore((state) => state.customThemes);
  const scenePalette = scene.kind === "image" ? scene.palette : null;
  return useMemo(() => {
    let colors: string[];
    if (scenePalette) {
      colors = backdropThemeFromScene(scenePalette, mode).colors
        .slice(1)
        .map(([r, g, b]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`);
    } else {
      const palette = resolveTheme(resolveThemeById(themeId, customThemes)).palette;
      colors = [palette.accentDeep, `color-mix(in srgb, ${palette.accentDeep} 50%, ${palette.info})`, palette.accent, palette.accentBright];
    }
    return Object.fromEntries(colors.map((color, index) => [`--wn-glow-${index + 1}`, color])) as CSSProperties;
  }, [customThemes, mode, scenePalette, themeId]);
}

type ModalItem = { key: string; title: string; page: AnnouncementPageDef | null };

function AnnouncementsModal({
  pages,
  notes,
  arrival,
  unasked,
  onClose,
}: {
  pages: readonly AnnouncementPageDef[];
  notes: NotesPage | null;
  arrival: Arrival | null;
  /** Opened by itself: the panel takes focus, so no button catches a stray Enter. */
  unasked: boolean;
  onClose: () => void;
}) {
  const appReduceMotion = useAppearanceStore((state) => state.interfacePreferences.reduceMotion);
  const systemReduceMotion = usePrefersReducedMotion();
  // Decided once: turning reduce motion on mid-flight does not bring a flight back.
  const [arrives] = useState(() => arrival != null && !appReduceMotion && !systemReduceMotion);
  const [flying, setFlying] = useState(arrives);
  const dialogReady = useArrivalDialogReady(arrives);
  const brandMarkRef = useRef<HTMLSpanElement>(null);
  const version = arrival?.version ?? null;
  const wordmarkSrc = useAdeWordmarkSrc();
  const windowInFront = useWindowInFront();
  const items = useMemo<ModalItem[]>(() => [
    ...pages.map((page) => ({ key: page.id, title: page.title, page })),
    ...(notes ? [{ key: "and-more", title: pages.length > 0 ? "And more" : "What changed", page: null }] : []),
  ], [notes, pages]);
  const [index, setIndex] = useState(0);
  // The arrival's staggered entrance is for the first page only; a page turned to enters at once.
  const [turned, setTurned] = useState(false);
  useEffect(() => {
    if (index > 0) setTurned(true);
  }, [index]);
  const item = items[Math.min(index, items.length - 1)]!;
  const last = index >= items.length - 1;

  // On screen means seen; pages closed before they were reached stay due.
  useEffect(() => {
    if (item.page) markAnnouncementSeen(item.page);
  }, [item.page]);

  const glowColors = useGlowColors();
  const Page = item.page?.Page ?? null;
  const flight = flying ? (
    <WhatsNewLogoFlight
      from={arrival?.from ?? null}
      target={brandMarkRef}
      targetReady={dialogReady}
      onLanded={() => setFlying(false)}
    />
  ) : null;
  if (!dialogReady) return flight;
  return (
    <>
      {flight}
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={`What's new: ${item.title}`}
        hideHeader
        hideClose
        width={1080}
        maxHeight="min(92vh, 900px)"
        bodyPadding={false}
        panelClassName={arrives ? `ade-whats-new ade-whats-new--arrive${turned ? "" : " ade-whats-new--intro"}` : "ade-whats-new"}
        panelStyle={glowColors}
        preventAutoFocus={unasked}
        testId="whats-new"
        footer={(
          <div className="ade-whats-new-foot">
            {items.length > 1 ? (
              <div className="ade-whats-new-dots" aria-label={`Page ${index + 1} of ${items.length}`}>
                {items.map((entry, entryIndex) => (
                  <button
                    key={entry.key}
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
                autoFocus={!unasked}
                onClick={() => (last ? onClose() : setIndex(index + 1))}
              >
                {last ? "Done" : "Next"}
                {last ? null : <ArrowRight size={12} weight="bold" aria-hidden />}
              </button>
            </div>
          </div>
        )}
      >
        {/* Colour from the window's background, drifting; each page moves it somewhere new. */}
        <div
          className="ade-whats-new-glow"
          data-page={index % 3}
          data-resting={windowInFront ? undefined : "true"}
          data-loop-clock="off"
          aria-hidden
        >
          <span />
          <span />
          <span />
        </div>
        <p className="ade-whats-new-brand">
          <span
            ref={brandMarkRef}
            className="ade-whats-new-mark"
            data-arrival={arrives ? (flying ? "waiting" : "landed") : undefined}
            style={{ "--wn-mark-mask": `url("${wordmarkSrc}")` } as CSSProperties}
          >
            <AdeWordmark alt="" draggable={false} />
          </span>
          <span className="ade-whats-new-title">
            What's new in ADE
            {version ? <span className="ade-whats-new-version">{version}</span> : null}
          </span>
        </p>
        <button type="button" className="kit-icon-btn ade-whats-new-close" aria-label="Close" onClick={onClose}>
          <X size={13} weight="bold" />
        </button>
        {Page ? (
          <Suspense fallback={<div className="ade-whats-new-loading" />}>
            <Page key={item.key} close={onClose} />
          </Suspense>
        ) : notes ? (
          <ReleaseNotesPage
            notes={notes.digest}
            resumedChats={notes.resumedChats}
            changelogUrl={notes.changelogUrl}
            githubReleaseUrl={notes.githubReleaseUrl}
          />
        ) : null}
      </Dialog>
    </>
  );
}
