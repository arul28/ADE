import { useEffect, useState } from "react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import type { DeviceToolId } from "./deviceTool";

type DeviceLoadingStep = "booting" | "streaming";

const STEP_MESSAGE: Record<DeviceLoadingStep, string> = {
  booting: "Booting device",
  streaming: "Connecting video",
};

/** A wait shorter than this needs no stopwatch; it is already over. */
const ELAPSED_AFTER_MS = 5_000;

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

/**
 * The one screen between pressing Start and seeing the device: two named
 * steps with the device above them, on the picker's own gradient page, so
 * pressing Start does not drop the user from a lit page onto a black one.
 *
 * A failure keeps the card and replaces the spinner with the sentence and the
 * one button worth pressing: the picker is not the answer to "the boot
 * failed", because the device the user chose is still the device they want.
 */
export function DeviceLoadingCard({
  tool,
  glyph: Glyph,
  name,
  subtitle,
  step,
  dataState,
  slowAfterMs,
  slowSentence,
  failure,
}: {
  /** Names the card's `data-{tool}-loading-*` markers. */
  tool: DeviceToolId;
  glyph: Icon;
  name: string;
  subtitle: string | null;
  step: DeviceLoadingStep;
  /** The value of `data-{tool}-loading-card` while the card waits. */
  dataState: string;
  /** Past this the wait stops looking normal, and the card says why. Null never says it. */
  slowAfterMs: number | null;
  slowSentence: string;
  /** Non-null turns the card into the failure state. */
  failure?: { sentence: string; onRetry: () => void } | null;
}) {
  const failed = failure != null;
  const message = failure ? failure.sentence : STEP_MESSAGE[step];
  const elapsedMs = useElapsedMs();
  // A failed card is not waiting for anything, so it carries neither.
  const elapsedSeconds = !failed && elapsedMs >= ELAPSED_AFTER_MS ? Math.floor(elapsedMs / 1_000) : null;
  const slow = !failed && slowAfterMs != null && elapsedMs >= slowAfterMs;
  return (
    <div
      role={failed ? "alert" : "status"}
      {...{ [`data-${tool}-loading-card`]: failed ? "failed" : dataState }}
      className="ade-tool-picker-static relative flex size-full items-center justify-center px-6 py-10"
    >
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-3 p-6 text-center">
        <Glyph size={44} aria-hidden="true" className="shrink-0 text-fg/70" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 break-words font-sans text-sm font-medium text-fg">
            {failed ? name : `Booting ${name}…`}
          </p>
          {subtitle ? <p className="min-w-0 break-words font-sans text-xs text-muted-fg">{subtitle}</p> : null}
        </div>
        <div className="flex min-w-0 items-center gap-2 font-sans text-xs text-muted-fg">
          {failed ? null : <Spinner />}
          <span className={cn("min-w-0 break-words", failed && "text-[var(--color-error)]")}>
            {message}
          </span>
          {elapsedSeconds != null ? (
            <span {...{ [`data-${tool}-loading-elapsed`]: "" }} className="shrink-0 tabular-nums text-muted-fg">
              {elapsedSeconds}s
            </span>
          ) : null}
        </div>
        {slow ? (
          <p
            {...{ [`data-${tool}-loading-slow`]: "" }}
            className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg"
          >
            {slowSentence}
          </p>
        ) : null}
        {failure ? (
          <Button variant="outline" size="sm" onClick={failure.onRetry} className="shrink-0">
            Try again
          </Button>
        ) : (
          <div
            className="flex w-24 gap-1"
            aria-label={step === "booting" ? "Step 1 of 2: boot device" : "Step 2 of 2: connect video"}
          >
            <span className="h-1 min-w-0 flex-1 rounded-full bg-fg/60" />
            <span
              className={cn(
                "h-1 min-w-0 flex-1 rounded-full",
                step === "streaming" ? "bg-fg/60" : "bg-muted",
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}
