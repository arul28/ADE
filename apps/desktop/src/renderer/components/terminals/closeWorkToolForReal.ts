// Mirror of lane mac-desktop (b18dd67ec) minus the mac-desktop tool; on merge, take theirs.
import type { OpenProjectBinding } from "../../../shared/types";
import type { WorkSidebarTab } from "../../state/appStore";
import {
  retakeAppleMiniPlayer,
  suppressAppleMiniPlayerHandoff,
} from "../apple/appleMiniPlayerStore";

/**
 * Closing a tool's TAB closes the tool, not just its tab.
 *
 * The tab strip used to be the whole story: closing the Browser tab parked the
 * native view but left every tab it had open running, closing the Apple
 * Development tab left the simulator booted with nothing on screen, and so on —
 * the tab came back to a tool that had never stopped. This is the one place
 * that turns a tab close into the tool's own shutdown call.
 *
 * Deliberately fire-and-forget: the tab must come off the strip whether or not
 * the runtime answers, so every call is dispatched here and its failure is
 * logged rather than awaited. The strip is view state; the tool is remote.
 *
 * The pin is the focused chat's machine, the same one the panel routes its own
 * calls through, so a tool owned by another machine is stopped on THAT machine.
 */
export type CloseWorkToolForRealArgs = {
  laneId: string | null;
  /** The chat the tool was attached to, for ownership-aware stop calls. */
  chatSessionId?: string | null;
  runtimePin?: OpenProjectBinding | null;
};

function logCloseFailure(tool: WorkSidebarTab, error: unknown): void {
  console.error(`[closeWorkToolForReal] Failed to close ${tool} for real`, { tool, error });
}

/**
 * Stops the tool behind a tab that is being closed.
 *
 * Every branch goes through the runtime pin the panel uses and swallows its
 * rejection into the log above. A tool with nothing to stop (Git, Files,
 * Terminal) has no branch: closing those tabs is already the whole close.
 */
export function closeWorkToolForReal(
  tool: WorkSidebarTab,
  { laneId, chatSessionId = null, runtimePin = null }: CloseWorkToolForRealArgs,
): void {
  const pin = runtimePin ?? undefined;
  switch (tool) {
    case "browser": {
      const browser = window.ade?.builtInBrowser;
      if (!browser?.getStatus || !browser.closeTab) return;
      // Every open tab, not just the active one: the pane's browser is a
      // collection, and "close the browser" means the collection.
      void browser.getStatus(undefined, pin)
        .then((status) => Promise.all(
          status.tabs.map((tab) => browser.closeTab({ tabId: tab.id }, pin)),
        ))
        .catch((error) => logCloseFailure(tool, error));
      return;
    }
    case "app-control": {
      const appControl = window.ade?.appControl;
      if (!appControl?.stop) return;
      void appControl.stop(undefined, pin)
        .catch((error) => logCloseFailure(tool, error));
      return;
    }
    case "ios": {
      const ios = window.ade?.iosSimulator;
      if (!ios?.shutdown) return;
      // The panel is about to unmount, which is also how a MINIMIZE looks.
      // Say which this is before it does, or the device floats on its way down.
      suppressAppleMiniPlayerHandoff();
      // A player already floating is showing a device that is about to stop.
      // `retake`, not `close`: the tool is going away, which is no reason to
      // remember this chat as one that refuses the preview.
      retakeAppleMiniPlayer();
      /*
       * A4: closing the Apple Development TAB closes the tool for real —
       * this chat's stream lease first, then the device session.
       *
       * The stop comes first and the shutdown follows it either way. The
       * helper's capture is lane-scoped and outlives the panel that started
       * it, so shutting the device down while a capture is still reading it
       * leaves an encoder pointed at a device that no longer exists; and a
       * stream stop that fails is not a reason to keep the tool running, so
       * the shutdown is chained off the settled stop rather than off success.
       *
       * The lane device itself stays REGISTERED: the pane's next visit shows
       * "{name} is off. [Start]" rather than the picker, because closing the
       * tab is a statement about the tool, not about which device this lane
       * uses.
       */
      const stopStream = ios.stopStream
        ? ios.stopStream(pin, { laneId, chatSessionId })
          .then(() => undefined)
          .catch((error) => logCloseFailure(tool, error))
        : Promise.resolve();
      void stopStream
        // The Work pane is the lane-scoped surface, so it asks the service to
        // stand the single-owner rule down rather than impersonating the owner.
        .then(() => ios.shutdown!({ chatSessionId, ignoreOwnership: true }, pin))
        .catch((error) => logCloseFailure(tool, error));
      return;
    }
    default:
      return;
  }
}
