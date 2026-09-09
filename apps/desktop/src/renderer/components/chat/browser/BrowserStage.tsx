/**
 * The surface the native browser view is positioned over.
 *
 * Its own file because everything in it exists to make a rectangle the
 * compositor paints on top of this renderer look like part of the pane: the
 * measured viewport frame, the snapshot underlay, the capture crop, the
 * launchpad shown when there is no page, and the letterbox caption.
 *
 * The page is inset 8px on every side inside a 10px-radius frame with a
 * hairline inset ring (Zen's compact mode). ADE's chrome then FRAMES the page
 * rather than butting a rounded pane against a square document — which is the
 * single cheapest thing that separates a premium browser from an iframe.
 */
import type { MutableRefObject, PointerEvent } from "react";
import {
  ArrowsLeftRight,
  ClipboardText,
  ClockCounterClockwise,
  Globe,
  RadioButton,
  X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import {
  BUILT_IN_BROWSER_VIEW_CORNER_RADIUS,
  type BuiltInBrowserEmulationState,
} from "../../../../shared/types/builtInBrowser";
import { emulationCaption, UNDERLAY_FADE_MS, type BrowserViewFrame } from "./browserViewGeometry";
import { revealTransition } from "../../../lib/motion";
import { cn } from "../../ui/cn";
import { TOOLBAR_FOCUS, TOOLBAR_MOTION } from "./browserChrome";
import type {
  BrowserCaptureSelection,
  BrowserFrame,
  BuiltInBrowserScreenshot,
} from "./browserPanelTypes";

/** One row in a launchpad group — a local server, a recent page, the clipboard. */
export type BrowserLaunchpadRow = {
  key: string;
  title: string;
  subtitle: string | null;
  /** `:5173`, printed inside the mini window mockup. Null for a plain row. */
  thumbLabel: string | null;
  /** Live local servers get a green dot; nothing else claims to be running. */
  live: boolean;
  icon: "server" | "clipboard" | "history";
  onSelect: () => void;
  /** Present only where forgetting a row means something. */
  onForget?: () => void;
};

export type BrowserLaunchpadGroup = {
  key: string;
  label: string;
  icon: "server" | "history";
  rows: BrowserLaunchpadRow[];
  /** Group-level "drop all of these". Only groups the app remembers have one. */
  onClear?: { label: string; run: () => void };
};

export type BrowserStageProps = {
  surfaceRef: MutableRefObject<HTMLDivElement | null>;
  stageRef: MutableRefObject<HTMLDivElement | null>;
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  captureImageRef: MutableRefObject<HTMLImageElement | null>;
  viewFrame: BrowserViewFrame;
  reduceMotion: boolean;
  onViewportAnimationComplete: () => void;
  underlay: { dataUrl: string; visible: boolean } | null;
  captureImageDataUrl: string | null;
  captureBase: BuiltInBrowserScreenshot | null;
  captureSelection: BrowserCaptureSelection | null;
  activeCaptureFrame: BrowserFrame | null;
  onCapturePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onCapturePointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onCapturePointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onCapturePointerCancel: (event?: PointerEvent<HTMLDivElement>) => void;
  showLaunchpad: boolean;
  apiAvailable: boolean;
  launchpadGroups: BrowserLaunchpadGroup[];
  letterboxed: boolean;
  emulation: BuiltInBrowserEmulationState | null;
  busy: string | null;
  onRotateEmulation: () => void;
};

/**
 * A 48×30 browser window, as a row icon.
 *
 * Synara's best idea: a local server is a *page*, so the thing standing in for
 * it should look like a window with a title bar rather than like the same globe
 * glyph six times in a column.
 */
function LaunchpadThumb({ label }: { label: string | null }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-[30px] w-12 shrink-0 flex-col overflow-hidden rounded-[5px]",
        "bg-white/[0.06] ring-1 ring-inset ring-white/[0.10]",
      )}
    >
      <span className="flex h-[9px] shrink-0 items-center gap-[2px] bg-white/[0.07] pl-[3px]">
        <span className="h-[3px] w-[3px] rounded-full bg-[#ff6b65]" />
        <span className="h-[3px] w-[3px] rounded-full bg-[#f4c047]" />
        <span className="h-[3px] w-[3px] rounded-full bg-[#45cf77]" />
      </span>
      {/*
        The port, and nothing else. A second line of text in a 30px window
        would only be the row's own title at 5px, which is a decoration
        pretending to be information.
      */}
      <span className="flex min-h-0 flex-1 items-center justify-center px-[3px]">
        <span className="truncate text-[6px] font-medium leading-none text-fg/60">{label}</span>
      </span>
    </span>
  );
}

function LaunchpadGroup({ group }: { group: BrowserLaunchpadGroup }) {
  return (
    <section aria-label={group.label} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-[11px] font-medium text-muted-fg/75">
        {group.icon === "server" ? <RadioButton size={13} /> : <ClockCounterClockwise size={13} />}
        {group.label}
        {group.onClear ? (
          <button
            type="button"
            onClick={group.onClear.run}
            className={cn(
              "ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-muted-fg/60",
              "hover:bg-white/[0.06] hover:text-fg/85",
              TOOLBAR_MOTION,
              TOOLBAR_FOCUS,
            )}
          >
            {group.onClear.label}
          </button>
        ) : null}
      </div>
      {/* One container, hairline-divided rows — not six floating cards. */}
      <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-white/[0.07]">
        {group.rows.map((row, index) => (
          <div
            key={row.key}
            className={cn(
              "group/row relative flex min-w-0 items-center gap-3",
              index > 0 ? "border-t border-white/[0.05]" : null,
            )}
          >
            <button
              type="button"
              onClick={row.onSelect}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-3 p-3 text-left",
                "transition-colors duration-[120ms] ease-out hover:bg-white/[0.04]",
                TOOLBAR_FOCUS,
              )}
            >
              {row.icon === "server" ? (
                <LaunchpadThumb label={row.thumbLabel} />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-[30px] w-12 shrink-0 items-center justify-center rounded-[5px] bg-white/[0.04] ring-1 ring-inset ring-white/[0.07]"
                >
                  {row.icon === "clipboard" ? (
                    <ClipboardText size={14} className="text-muted-fg/70" />
                  ) : (
                    <Globe size={14} className="text-muted-fg/70" />
                  )}
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate text-[13px] font-medium text-fg/88">{row.title}</span>
                {row.subtitle ? (
                  <span className="truncate text-[11.5px] text-muted-fg/70">{row.subtitle}</span>
                ) : null}
              </span>
              {row.live ? (
                <span
                  aria-label="Listening"
                  title="This port is listening right now"
                  className="h-[6px] w-[6px] shrink-0 rounded-full bg-emerald-400"
                />
              ) : null}
            </button>
            {row.onForget ? (
              <button
                type="button"
                onClick={row.onForget}
                aria-label={`Forget ${row.title}`}
                className={cn(
                  "mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                  "text-muted-fg/50 opacity-0 hover:bg-white/[0.07] hover:text-fg/85",
                  "group-hover/row:opacity-100 focus-visible:opacity-100",
                  TOOLBAR_MOTION,
                  TOOLBAR_FOCUS,
                )}
              >
                <X size={11} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function BrowserStage({
  surfaceRef,
  stageRef,
  viewportRef,
  captureImageRef,
  viewFrame,
  reduceMotion,
  onViewportAnimationComplete,
  underlay,
  captureImageDataUrl,
  captureBase,
  captureSelection,
  activeCaptureFrame,
  onCapturePointerDown,
  onCapturePointerMove,
  onCapturePointerUp,
  onCapturePointerCancel,
  showLaunchpad,
  apiAvailable,
  launchpadGroups,
  letterboxed,
  emulation,
  busy,
  onRotateEmulation,
}: BrowserStageProps) {
  return (
    /*
      The native view is a rectangle the compositor puts on top of this
      renderer, so the rounded corners and the hairline have to come from
      the host it is positioned inside — and its bounds are inset by that
      hairline so the ring is never painted over. The 8px padding is what
      turns the page into a card the chrome holds.
    */
    <div
      ref={surfaceRef}
      className="relative flex min-h-[160px] min-w-0 flex-1 flex-col p-2"
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-[var(--color-surface)] ring-1 ring-inset ring-white/[0.08]">
        <div ref={stageRef} className="relative min-h-0 min-w-0 flex-1">
          <motion.div
            ref={viewportRef}
            aria-hidden="true"
            className="pointer-events-none absolute overflow-hidden"
            /*
              The same radius the native view is rounded to in main
              (`applyTabViewCornerRadius`). The view is composited ABOVE this
              renderer, so this element cannot mask it — the two are one radius
              read from one constant precisely because CSS cannot enforce it.
            */
            style={{ borderRadius: BUILT_IN_BROWSER_VIEW_CORNER_RADIUS }}
            initial={false}
            animate={{
              left: viewFrame.left,
              top: viewFrame.top,
              width: viewFrame.width,
              height: viewFrame.height,
            }}
            transition={reduceMotion ? { duration: 0 } : revealTransition}
            onAnimationComplete={onViewportAnimationComplete}
          >
            <AnimatePresence initial={false}>
              {underlay ? (
                <motion.img
                  key="ade-browser-underlay"
                  data-testid="browser-underlay"
                  src={underlay.dataUrl}
                  alt=""
                  draggable={false}
                  initial={{ opacity: 1 }}
                  animate={{ opacity: underlay.visible ? 1 : 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: UNDERLAY_FADE_MS / 1000, ease: "easeOut" }}
                  className="h-full w-full object-cover object-top"
                />
              ) : null}
            </AnimatePresence>
          </motion.div>

          {captureImageDataUrl && captureBase?.width && captureBase.height ? (
            <div
              className="absolute inset-0 cursor-crosshair select-none bg-black"
              onPointerDown={onCapturePointerDown}
              onPointerMove={onCapturePointerMove}
              onPointerUp={onCapturePointerUp}
              onPointerCancel={onCapturePointerCancel}
            >
              <img
                ref={captureImageRef}
                src={captureImageDataUrl}
                alt=""
                draggable={false}
                className="h-full w-full object-contain"
              />
              <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-fg/85">
                Drag to attach a browser crop with page context
              </div>
              {captureSelection && activeCaptureFrame ? (
                <div
                  className="pointer-events-none absolute border border-sky-200 bg-sky-400/14 shadow-[0_0_0_9999px_rgba(0,0,0,0.42)]"
                  style={{
                    left: captureSelection.bounds.left + (activeCaptureFrame.x * captureSelection.bounds.scaleX),
                    top: captureSelection.bounds.top + (activeCaptureFrame.y * captureSelection.bounds.scaleY),
                    width: Math.max(1, activeCaptureFrame.width * captureSelection.bounds.scaleX),
                    height: Math.max(1, activeCaptureFrame.height * captureSelection.bounds.scaleY),
                  }}
                />
              ) : null}
            </div>
          ) : showLaunchpad || !apiAvailable ? (
            /*
              The launchpad, not an empty state: a browser with no page is a
              browser waiting for an address, so it offers the addresses this
              machine actually has instead of apologising for being empty.
            */
            <motion.div
              data-testid="browser-launchpad"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={revealTransition}
              className="absolute inset-0 overflow-y-auto"
            >
              {/*
                Optically centred against the whole surface, the way t3code
                centres its picker: a column pinned to the top of an 800px pane
                reads as a page that failed to load rather than as an offer.
              */}
              <div className="flex min-h-full w-full items-center justify-center px-5 py-8">
              <div className="flex w-full max-w-[576px] flex-col gap-5">
                {apiAvailable ? (
                  /*
                    No field here.

                    This column used to open with a boxed copy of the omnibox,
                    which put two live URL fields on screen at once writing the
                    same state — two answers to "where do I type". The chrome
                    row's field is the omnibox on every other page, so it is the
                    omnibox here too, and it is the one that takes the caret.
                    What is left is what the launchpad is actually for: the
                    addresses this machine already has.
                  */
                  <>
                    {launchpadGroups.map((group) => (
                      <LaunchpadGroup key={group.key} group={group} />
                    ))}
                  </>
                ) : (
                  <div className="flex flex-col gap-1.5 text-center">
                    <div className="text-[13px] font-medium text-fg/80">ADE browser unavailable</div>
                    <div className="text-[11.5px] text-muted-fg/65">
                      This renderer does not expose window.ade.builtInBrowser.
                    </div>
                  </div>
                )}
              </div>
              </div>
            </motion.div>
          ) : null}
        </div>

        {/*
          The caption is the honest label on a letterboxed view: the page is
          being rendered at these CSS pixels, whatever the pane happens to be.
          It lives inside the same framed card, so the frame stays one object.
        */}
        {letterboxed ? (
          <div className="flex h-[26px] shrink-0 select-none items-center justify-center gap-2 border-t border-white/[0.06]">
            <span
              data-testid="browser-emulation-caption"
              className="font-mono text-[10px] tracking-[0.02em] text-muted-fg/75"
            >
              {emulationCaption(emulation, viewFrame.scale)}
            </span>
            <button
              type="button"
              onClick={onRotateEmulation}
              disabled={busy === "emulation"}
              title="Rotate"
              aria-label="Rotate the emulated device"
              className={cn(
                "inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] text-muted-fg/60",
                "hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-40",
                TOOLBAR_MOTION,
                TOOLBAR_FOCUS,
              )}
            >
              <ArrowsLeftRight size={11} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
