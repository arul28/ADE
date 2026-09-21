import { DeviceMobile, DeviceTablet } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { describeAppleError } from "./appleErrors";

export type AppleLoadingStage = "starting" | "streaming";

export const APPLE_LOADING_MESSAGE = {
  starting: "Starting device…",
  streaming: "Connecting video…",
} as const;

/**
 * The one screen between pressing Start and seeing the device.
 *
 * Two steps, named, with the device you picked at the top of them — so the
 * wait is a place rather than a blank column. A failure keeps the card and
 * replaces the spinner with the sentence and the one button worth pressing:
 * the picker is not the answer to "the boot failed", because the device you
 * chose is still the device you want.
 */
export function AppleDeviceLoadingCard({
  name,
  runtime,
  family,
  stage,
  error,
  onRetry,
}: {
  name: string;
  runtime: string | null;
  family: "iphone" | "ipad";
  stage: AppleLoadingStage;
  /** Non-null turns the card into the failure state. */
  error?: unknown;
  onRetry: () => void;
}) {
  const failed = error != null;
  const Icon = family === "ipad" ? DeviceTablet : DeviceMobile;
  const message = failed ? describeAppleError(error).sentence : APPLE_LOADING_MESSAGE[stage];
  return (
    <div
      role={failed ? "alert" : "status"}
      data-apple-loading-card={failed ? "failed" : stage}
      className="flex size-full items-center justify-center bg-bg px-6 py-10"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-muted/30">
          <Icon size={24} className="text-muted-fg" />
        </div>
        <div className="space-y-1">
          <p className="font-sans text-sm font-medium text-fg">{name}</p>
          {runtime ? <p className="font-sans text-xs text-muted-fg">{runtime}</p> : null}
        </div>
        <div className="flex items-center gap-2 font-sans text-xs text-muted-fg">
          {failed ? null : (
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
            />
          )}
          <span className={failed ? "text-[var(--color-error)]" : undefined}>{message}</span>
        </div>
        {failed ? (
          <button
            type="button"
            className="rounded-md px-2 py-1 font-sans text-xs font-medium text-fg/80 hover:bg-white/[0.06] hover:text-fg"
            onClick={onRetry}
          >
            Try again
          </button>
        ) : (
          <div
            className="flex w-24 gap-1"
            aria-label={
              stage === "starting" ? "Step 1 of 2: start device" : "Step 2 of 2: connect video"
            }
          >
            <span className="h-1 flex-1 rounded-full bg-fg/60" />
            <span
              className={cn(
                "h-1 flex-1 rounded-full",
                stage === "streaming" ? "bg-fg/60" : "bg-muted",
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}
