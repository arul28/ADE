/**
 * The composer picker.
 *
 * The `composer-picker` placement, opened by the manifest's
 * `composer-menu-item` socket. There is one entry: the compiled
 * `LinearIssueSelectModal` in its `attach` mode, which is `LinearIssueBrowser`
 * in `singleSelect` — the same component the app opened from the composer's
 * Linear button, now a row in the composer's three-dot menu.
 *
 * Attach then close IS the picker's whole contract. Nothing else finishes it:
 * the host's composer socket is waiting on the attach, and the surface stays up
 * until the page closes it.
 *
 * ## The chrome this placement does not draw
 *
 * The pane used to draw its own header and its own `bg-black/55` backdrop here,
 * inside the card the host had already drawn and already titled — two headers
 * over one list, a black sheet across the reader's window, and a dialog asking
 * for `min(1760px, 100vw - 28px)` by `min(940px, 100dvh - 28px)` inside a frame
 * a fraction of that. `drawsOwnChrome` answers per placement, so the `overlay`
 * fallback — a page floating over the app with nothing around it — keeps the
 * header it genuinely needs.
 */

import React, { useCallback, useMemo, useState } from "react";

import type { PluginWebviewContext } from "../bridge";
import { LinearIssueSelectModal } from "../components/LinearIssueSelectModal";
import { linkIssueToLane } from "../host/actions";
import { drawsOwnChrome } from "../host/placement";
import { closeSurface, composerAttach, openSettings, toast } from "../host/ui";
import type { LaneLinearIssue } from "../types";

export function PickerEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const projectRoot = context.project?.root ?? null;
  const chrome = drawsOwnChrome(context.placement);
  // The picker opens open. Dismissing it — Escape, the backdrop, the header's
  // close — is a request to close the PLACEMENT, not to leave an empty page
  // behind, so `onOpenChange(false)` routes to `closeSurface()`.
  const [open, setOpen] = useState(true);

  /**
   * The lane this picker was opened FOR, when it was opened for one.
   *
   * The composer's own menu row opens this surface with no pointer, and the
   * answer is a chip on the composer. The chat menu's Issue context card opens
   * it through `openIssuePickerSurface`, which passes the chat's lane — because
   * that card's Attach means "link this issue to this chat's lane", not "put a
   * chip in the box". One surface, two callers, and the pointer is which.
   */
  const laneId = useMemo(() => {
    const value = context.pointer?.laneId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }, [context.pointer]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) void closeSurface();
  }, []);

  const handleSelectIssue = useCallback((issue: LaneLinearIssue) => {
    setOpen(false);
    void (async () => {
      if (laneId) {
        const result = await linkIssueToLane(issue.id, laneId);
        if (result?.message) {
          await toast({ level: result.ok === false ? "error" : "success", message: result.message });
        }
        // A refusal leaves the list up, so the reader can pick another issue
        // rather than watching the surface close on a failure.
        if (result?.ok === false) {
          setOpen(true);
          return;
        }
        await closeSurface();
        return;
      }
      await composerAttach({
        provider: "linear",
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
      });
      await closeSurface();
    })();
  }, [laneId]);

  return (
    // A sizing shim, not a ground: it paints nothing, and it exists so a host
    // that measures the document to size the placement reads the picker's own
    // height rather than the zero a `fixed` portal would contribute.
    <div style={{ height: "100dvh" }}>
      {/* Every prop below is the compiled composer's own call site
          (`AgentChatComposer.tsx`), string for string: the picker the reader
          used to press opened exactly this. `pinnedIssue` and its busy/disabled
          flags belonged to the composer's local state, which a guest does not
          share — see the entry's gap notes. */}
      <LinearIssueSelectModal
        open={open}
        ariaLabel="Attach Linear issue"
        projectRoot={projectRoot}
        selectedIssue={null}
        pinnedIssueLabel="Attached to chat"
        actionLabel="Attach issue"
        actionBusyLabel="Attaching issue"
        showBranchPreview={false}
        chrome={chrome}
        onOpenChange={handleOpenChange}
        onSelectIssue={handleSelectIssue}
        onOpenLinearSettings={() => void openSettings({ socketId: "connection" })}
      />
    </div>
  );
}
