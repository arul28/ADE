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
import { floatingLayerBusy, launchGateOpen } from "../ui/overlayState";
import type { AnnouncementPageDef } from "./announcementPages";
import {
  allAnnouncements,
  dueAnnouncements,
  inProjectShowingAllowed,
  markAnnouncementSeen,
  markShowing,
  useSeenAnnouncements,
} from "./announcementSeen";
import { releaseNotesDigest, type ReleaseNotesDigest } from "./releaseNotesDigest";
import { ReleaseNotesPage } from "./ReleaseNotesPage";
import "./announcements.css";
import { AdeWordmark, useAdeWordmarkSrc } from "../ui/AdeWordmark";
import type { ScreenBox } from "../ui/LiquidGlassLogoReveal";
import { afterBootSplash, bootSplashLogoBox } from "../app/BootSplashReveal";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useArrivalDialogReady, WhatsNewLogoFlight } from "./WhatsNewArrival";

/**
 * The "What's new" modal. It opens three ways:
 *
 * - **After an update** this computer installed itself (not one pressed on
 *   another machine): on the first launch of the new version, on whatever
 *   screen ADE opens to. Up to three unseen catalogue pages, then "And more",
 *   the release notes since the version it came from. AutoUpdateControl asks
 *   for it (`openWhatsNewAfterUpdate`) in place of its old notice. It waits
 *   for the boot splash to go, then arrives: the logo flies from the splash
 *   into the header while the window opens around it (`WhatsNewArrival`).
 *   The other two ways open with the plain dialog fade.
 * - **Inside a project**, by itself: up to three unseen catalogue pages, at
 *   most once a day (an after-update showing counts), and only when nothing
 *   else wants the user's attention — onboarding finished or was skipped
 *   before this launch, no dialog, setup screen or tour card is up, and the
 *   project has been open a few seconds.
 * - **Help › What's new** or the command palette: every catalogue page,
 *   newest first, then this version's notes.
 *
 * A catalogue page counts as seen once it is on screen, whichever way it
 * opened, and never shows by itself again (`announcementSeen.ts`).
 *
 * Cost: with nothing due (the usual case) this renders nothing and holds one
 * storage subscription. With pages due it checks the conditions every few
 * seconds until it shows, then stops.
 */

const OPEN_EVENT = "ade:open-whats-new";
const AFTER_UPDATE_EVENT = "ade:open-whats-new-after-update";
/** The project settles before anything shows over it. */
const SETTLE_MS = 4_000;
const CHECK_INTERVAL_MS = 3_000;

export type AfterUpdateDetail = {
  version: string;
  fromVersion: string | null;
  resumedChats: readonly UpdateInterruptedChat[];
  changelogUrl: string | null;
  githubReleaseUrl: string | null;
  /** Called once the modal closes, so the update record can be put away. */
  onClose: () => void;
};

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
  onClose?: () => void;
  /** After an update: the logo flies in, from the splash's last logo box when there is one. */
  arrival?: Arrival;
};

/** Opens every "What's new" page (Help menu, command palette). */
export function openWhatsNew(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** The first launch after this computer installed an update (AutoUpdateControl). */
export function openWhatsNewAfterUpdate(detail: AfterUpdateDetail): void {
  window.dispatchEvent(new CustomEvent<AfterUpdateDetail>(AFTER_UPDATE_EVENT, { detail }));
}

export function AnnouncementsHost() {
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
      cancelArrival = afterBootSplash(() => setShowing({
        pages: dueAnnouncements(),
        notes: {
          digest: releaseNotesDigest(detail.version, detail.fromVersion),
          resumedChats: detail.resumedChats,
          changelogUrl: detail.changelogUrl,
          githubReleaseUrl: detail.githubReleaseUrl,
        },
        onClose: detail.onClose,
        arrival: { version: detail.version, from: bootSplashLogoBox() },
      }));
    };
    window.addEventListener(OPEN_EVENT, openAll);
    window.addEventListener(AFTER_UPDATE_EVENT, openAfterUpdate);
    return () => {
      window.removeEventListener(OPEN_EVENT, openAll);
      window.removeEventListener(AFTER_UPDATE_EVENT, openAfterUpdate);
      cancelArrival();
    };
  }, []);

  // Wait for a quiet moment inside a project, once per launch and once a day.
  const waiting = !showing && !shownThisLaunch && inProject && due.length > 0;
  useEffect(() => {
    if (!waiting) return undefined;
    const since = Date.now();
    const check = () => {
      if (document.hidden || Date.now() - since < SETTLE_MS) return;
      if (!onboardingSettledBeforeThisLaunch() || floatingLayerBusy() || launchGateOpen()) return;
      setShownThisLaunch(true);
      if (!inProjectShowingAllowed()) return;
      const pages = dueAnnouncements();
      if (pages.length === 0) return;
      markShowing();
      setShowing({ pages, notes: null });
    };
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [waiting]);

  const showingRef = useRef(showing);
  showingRef.current = showing;
  const close = useCallback(() => {
    showingRef.current?.onClose?.();
    setShowing(null);
  }, []);
  if (!showing || (showing.pages.length === 0 && !showing.notes)) return null;
  return <AnnouncementsModal pages={showing.pages} notes={showing.notes} arrival={showing.arrival ?? null} onClose={close} />;
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
  onClose,
}: {
  pages: readonly AnnouncementPageDef[];
  notes: NotesPage | null;
  arrival: Arrival | null;
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
                autoFocus
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
        <div className="ade-whats-new-glow" data-page={index % 3} aria-hidden>
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
