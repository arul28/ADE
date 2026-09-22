import { useEffect, useState } from "react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import {
  AppleDeviceIPadGlyph,
  AppleDeviceIPhoneGlyph,
  AppleDeviceTvGlyph,
  AppleDeviceVisionGlyph,
  AppleDeviceWatchGlyph,
} from "../ui/appleIcons";
import { describeAppleError } from "./appleErrors";
import type { AppleDeviceFamilyId } from "./appleDeviceFamily";

export type AppleLoadingStage = "starting" | "streaming";

export const APPLE_LOADING_MESSAGE = {
  starting: "Booting device",
  streaming: "Connecting video",
} as const;

/** A wait shorter than this needs no stopwatch; it is already over. */
export const APPLE_LOADING_ELAPSED_AFTER_MS = 5_000;
/** Past this the wait stops looking normal, so the card says that it is. */
export const APPLE_LOADING_SLOW_AFTER_MS = 60_000;
export const APPLE_LOADING_SLOW_SENTENCE =
  "Still booting — the first boot of a simulator can take a minute.";

/**
 * "Installed simulator · {model} · {runtime}", with the parts that exist.
 *
 * The first word is load-bearing: every device this card can be showing came
 * from the machine's own installed runtimes, and saying so is what stops the
 * wait reading as a download.
 */
export function appleLoadingSubtitle(
  model: string | null | undefined,
  runtime: string | null | undefined,
): string {
  return ["Installed simulator", model, runtime]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");
}

/**
 * Milliseconds since the card appeared, ticking once a second.
 *
 * Mount rather than stage change: the user pressed Start once, and a counter
 * that restarted when the boot handed over to the video step would under-report
 * exactly the waits worth reporting.
 */
function useElapsedMs(): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return elapsedMs;
}

const FAMILY_GLYPH: Record<AppleDeviceFamilyId, Icon> = {
  iphone: AppleDeviceIPhoneGlyph,
  ipad: AppleDeviceIPadGlyph,
  watch: AppleDeviceWatchGlyph,
  tv: AppleDeviceTvGlyph,
  vision: AppleDeviceVisionGlyph,
  other: AppleDeviceIPhoneGlyph,
};

/**
 * The one screen between pressing Start and seeing the device (§B5).
 *
 * Ported shape from t3code's `DeviceLoadingView` — two named steps with the
 * device you picked above them, so the wait is a place rather than a blank
 * column — restyled in round 3 as a gradient card on the picker's own page, so
 * pressing Start does not drop you from a lit page onto a black one. The copy
 * is round 2's, unchanged.
 *
 * A failure keeps the card and replaces the spinner with the sentence and the
 * one button worth pressing: the picker is not the answer to "the boot
 * failed", because the device you chose is still the device you want.
 */
export function AppleDeviceLoadingCard({
  name,
  runtime,
  model,
  family,
  stage,
  error,
  onRetry,
}: {
  name: string;
  runtime: string | null;
  /** The model, when the name is a rename that hides it. */
  model?: string | null;
  family: AppleDeviceFamilyId;
  stage: AppleLoadingStage;
  /** Non-null turns the card into the failure state. */
  error?: unknown;
  onRetry: () => void;
}) {
  const failed = error != null;
  const Glyph = FAMILY_GLYPH[family] ?? AppleDeviceIPhoneGlyph;
  const message = failed ? describeAppleError(error).sentence : APPLE_LOADING_MESSAGE[stage];
  const elapsedMs = useElapsedMs();
  // A failed card is not waiting for anything, so it carries neither.
  const elapsedSeconds = !failed && elapsedMs >= APPLE_LOADING_ELAPSED_AFTER_MS
    ? Math.floor(elapsedMs / 1_000)
    : null;
  const slow = !failed && elapsedMs >= APPLE_LOADING_SLOW_AFTER_MS;
  const subtitle = appleLoadingSubtitle(model, runtime);
  return (
    <div
      role={failed ? "alert" : "status"}
      data-apple-loading-card={failed ? "failed" : stage}
      className="ade-tool-picker-static relative flex size-full items-center justify-center px-6 py-10"
    >
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-3 p-6 text-center">
        <Glyph size={44} aria-hidden="true" className="shrink-0 text-fg/70" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 break-words font-sans text-sm font-medium text-fg">
            {failed ? name : `Booting ${name}…`}
          </p>
          <p className="min-w-0 break-words font-sans text-xs text-muted-fg">{subtitle}</p>
        </div>
        <div className="flex min-w-0 items-center gap-2 font-sans text-xs text-muted-fg">
          {failed ? null : (
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
            />
          )}
          <span className={cn("min-w-0 break-words", failed && "text-[var(--color-error)]")}>
            {message}
          </span>
          {elapsedSeconds != null ? (
            <span data-apple-loading-elapsed="" className="shrink-0 tabular-nums text-muted-fg">
              {elapsedSeconds}s
            </span>
          ) : null}
        </div>
        {slow ? (
          <p
            data-apple-loading-slow=""
            className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg"
          >
            {APPLE_LOADING_SLOW_SENTENCE}
          </p>
        ) : null}
        {failed ? (
          <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
            Try again
          </Button>
        ) : (
          <div
            className="flex w-24 gap-1"
            aria-label={
              stage === "starting" ? "Step 1 of 2: boot device" : "Step 2 of 2: connect video"
            }
          >
            <span className="h-1 min-w-0 flex-1 rounded-full bg-fg/60" />
            <span
              className={cn(
                "h-1 min-w-0 flex-1 rounded-full",
                stage === "streaming" ? "bg-fg/60" : "bg-muted",
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}
