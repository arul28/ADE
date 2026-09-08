/**
 * The surface the native browser view is positioned over.
 *
 * Its own file because everything in it exists to make a rectangle the
 * compositor paints on top of this renderer look like part of the pane: the
 * measured viewport frame, the snapshot underlay, the capture crop, the
 * launchpad shown when there is no page, and the letterbox caption.
 */
import type { MutableRefObject, PointerEvent } from "react";
import { ArrowsLeftRight, ClipboardText, Globe } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import type { BuiltInBrowserEmulationState } from "../../../../shared/types/builtInBrowser";
import { emulationCaption, UNDERLAY_FADE_MS, type BrowserViewFrame } from "./browserViewGeometry";
import { revealTransition } from "../../../lib/motion";
import { cn } from "../../ui/cn";
import { TOOLBAR_FOCUS, TOOLBAR_MOTION } from "./browserChrome";
import type {
  BrowserCaptureSelection,
  BrowserFrame,
  BuiltInBrowserScreenshot,
} from "./browserPanelTypes";

export type BrowserLaunchpadChip = {
  key: string;
  label: string;
  hint: string | null;
  icon: "server" | "clipboard";
  onSelect: () => void;
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
  launchpadChips: BrowserLaunchpadChip[];
  letterboxed: boolean;
  emulation: BuiltInBrowserEmulationState | null;
  busy: string | null;
  onRotateEmulation: () => void;
};

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
  launchpadChips,
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
      hairline so the border is never painted over.
    */
    <div
      ref={surfaceRef}
      className="relative flex min-h-[160px] min-w-0 flex-1 flex-col overflow-hidden rounded-[6px] border border-white/[0.08] bg-[var(--color-bg)]"
    >
      <div ref={stageRef} className="relative min-h-0 min-w-0 flex-1">
        <motion.div
          ref={viewportRef}
          aria-hidden="true"
          className="pointer-events-none absolute overflow-hidden rounded-[5px]"
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
            <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-sky-300/18 bg-black/65 px-2 py-1 text-[11px] font-medium text-sky-50/85">
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
            className="absolute inset-0 flex select-none flex-col items-center justify-center gap-2.5 px-5 text-center"
          >
            <Globe size={26} weight="duotone" className="text-[var(--color-accent)]/35" />
            <div className="text-[12.5px] font-medium text-fg/80">
              {apiAvailable ? "Open a page" : "ADE browser unavailable"}
            </div>
            {apiAvailable ? (
              <>
                {launchpadChips.length > 0 ? (
                  <div
                    role="group"
                    aria-label="Suggested pages"
                    className="flex max-w-full flex-wrap items-center justify-center gap-1.5"
                  >
                    {launchpadChips.map((chip, index) => (
                      <motion.button
                        key={chip.key}
                        type="button"
                        onClick={chip.onSelect}
                        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18, ease: "easeOut", delay: reduceMotion ? 0 : index * 0.02 }}
                        className={cn(
                          "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-white/[0.09] bg-card/60 px-2.5",
                          "text-[10.5px] font-medium text-fg/78",
                          "transition-colors duration-[120ms] ease-out hover:border-white/[0.18] hover:bg-card",
                          TOOLBAR_FOCUS,
                        )}
                      >
                        {chip.icon === "clipboard" ? (
                          <ClipboardText size={11} className="shrink-0 opacity-70" />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="h-[5px] w-[5px] shrink-0 rounded-full bg-emerald-400 shadow-[0_0_0_2.5px_rgba(52,211,153,0.16)]"
                          />
                        )}
                        <span className="min-w-0 truncate">{chip.label}</span>
                        {chip.hint ? (
                          <span className="min-w-0 shrink truncate text-muted-fg/60">{chip.hint}</span>
                        ) : null}
                      </motion.button>
                    ))}
                  </div>
                ) : null}
                <div className="max-w-[340px] text-[10.5px] leading-[15px] text-muted-fg/70">
                  Type an address above, or let an agent open one with{" "}
                  <span className="font-mono text-fg/65">ade browser open</span>.
                </div>
              </>
            ) : (
              <div className="max-w-[340px] text-[11px] leading-5 text-muted-fg/60">
                This renderer does not expose window.ade.builtInBrowser.
              </div>
            )}
          </motion.div>
        ) : null}
      </div>

      {/*
        The caption is the honest label on a letterboxed view: the page is
        being rendered at these CSS pixels, whatever the pane happens to be.
      */}
      {letterboxed ? (
        <div className="flex h-[26px] shrink-0 select-none items-center justify-center gap-2 border-t border-white/[0.06] bg-white/[0.015]">
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
  );
}
