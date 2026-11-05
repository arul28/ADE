import type { ReactNode } from "react";
import { SpinnerGap, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import { Banner } from "../ui/notice";
import { DRAWER_ICON_BUTTON } from "../ui/drawerPrimitives";

/**
 * The frame every device Tools drawer shares: the header with the working
 * spinner and Close, the error banner, the "Reading device settings…" row,
 * and the scrolling column of group cards (`children`).
 *
 * Opaque `bg-surface` with its own `border-l`: the drawer can sit over a live
 * device picture, and nothing there may be translucent.
 */
export function DeviceToolsDrawerShell({
  tool,
  pending,
  error,
  onDismissError,
  reading,
  onClose,
  className,
  children,
}: {
  /** Prefixes the test ids and the error report surface. */
  tool: "apple" | "android";
  pending: boolean;
  /** The drawer's current error, already put into words. */
  error: { sentence: string; detail?: string | null } | null;
  onDismissError: () => void;
  /** True while the first settings read is out. */
  reading: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex h-full min-h-0 w-full min-w-0 flex-col border-l border-border bg-surface text-sm", className)}
      data-testid={`${tool}-tools-drawer`}
    >
      <div className="flex h-9 min-w-0 shrink-0 flex-nowrap items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">Tools</span>
        {pending ? <SpinnerGap size={14} className="shrink-0 animate-spin text-muted-fg" aria-label="Working" /> : null}
        <PaneTooltip label="Close tools" side="bottom">
          <button type="button" className={cn(DRAWER_ICON_BUTTON, "shrink-0")} aria-label="Close tools" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </PaneTooltip>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {error ? (
          <Banner
            layout="inline"
            testId={`${tool}-drawer-error`}
            style={{ margin: 8 }}
            model={{
              id: `${tool}-drawer-error`,
              tone: "error",
              title: error.sentence,
              report: { surface: `${tool}_tools_drawer`, technicalDetail: error.detail ?? null },
              dismiss: { label: "Dismiss", onDismiss: onDismissError },
            }}
          />
        ) : null}
        {reading && !error ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-fg">
            <SpinnerGap size={14} className="animate-spin" aria-hidden="true" /> Reading device settings…
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-2 p-2.5">{children}</div>
      </div>
    </div>
  );
}

/**
 * The drawer's dock: an opaque overlay just left of the rail (`w-14`) in a
 * narrow pane, so the rail stays usable; docked beside the picture from
 * 700 px. 700 − 288 = 412 px of picture, twice the 200 px floor.
 */
export const DEVICE_DRAWER_DOCK_CLASS = cn(
  "absolute inset-y-0 right-14 z-20 w-[min(18rem,calc(100%-3.5rem))] shadow-lg",
  "@[700px]:static @[700px]:w-72 @[700px]:shrink-0 @[700px]:shadow-none",
);
