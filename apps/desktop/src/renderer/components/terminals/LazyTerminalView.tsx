import { lazy, Suspense, useState, type ComponentProps, type ComponentType } from "react";
import type { TerminalView as TerminalViewComponent } from "./TerminalView";
import { scheduleQuietRoutePreload } from "../../lib/routePreload";

/*
 * The Work page's terminal, without xterm in the Work page's own code.
 *
 * `TerminalView` brings xterm and its add-ons (about 0.5 MB). A cold start
 * that opens on a chat does not draw a terminal, so that code loads when the
 * first terminal mounts, or earlier from `preloadTerminalView`. A terminal
 * that mounts before the code arrives shows an empty box of the same size
 * first; xterm draws its rows there once it loads, as it does after a PTY
 * attach.
 */

type TerminalViewProps = ComponentProps<typeof TerminalViewComponent>;

let loadedTerminalView: ComponentType<TerminalViewProps> | null = null;
let terminalViewLoad: Promise<{ default: ComponentType<TerminalViewProps> }> | null = null;

/** Load the terminal code now. A second call returns the same load. */
export function preloadTerminalView(): Promise<{ default: ComponentType<TerminalViewProps> }> {
  if (!terminalViewLoad) {
    terminalViewLoad = import("./TerminalView").then((module) => {
      loadedTerminalView = module.TerminalView;
      return { default: module.TerminalView };
    });
    // A failed load is shown by the terminal that needs it; the next call tries again.
    terminalViewLoad.catch(() => {
      terminalViewLoad = null;
    });
  }
  return terminalViewLoad;
}

/**
 * Load the terminal code after the person stops for a moment
 * (`scheduleQuietRoutePreload`), once per window. Returns the cancel for an
 * effect cleanup; a schedule that ran stays done.
 */
let terminalViewPreloadScheduled = false;
export function scheduleTerminalViewPreload(): () => void {
  if (terminalViewPreloadScheduled || loadedTerminalView) return () => {};
  terminalViewPreloadScheduled = true;
  let ran = false;
  const cancel = scheduleQuietRoutePreload(() => {
    ran = true;
    void preloadTerminalView().catch(() => undefined);
  });
  return () => {
    if (ran) return;
    cancel();
    terminalViewPreloadScheduled = false;
  };
}

const LazyLoadedTerminalView = lazy(preloadTerminalView);

export function TerminalView(props: TerminalViewProps) {
  // Chosen once per mount: a terminal must not switch component types (and
  // remount) when the code arrives during its life.
  const [Component] = useState<ComponentType<TerminalViewProps>>(
    () => loadedTerminalView ?? LazyLoadedTerminalView,
  );
  return (
    <Suspense fallback={<div className={props.className} aria-busy="true" />}>
      <Component {...props} />
    </Suspense>
  );
}
