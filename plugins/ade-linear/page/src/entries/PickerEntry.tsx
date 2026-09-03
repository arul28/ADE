/**
 * The composer picker.
 *
 * The `composer-picker` placement, opened by the manifest's composer-action
 * socket and by the chat-header-action socket. Both press the same surface, so
 * there is one entry: the compiled `LinearIssueSelectModal` in its `attach`
 * mode, which is `LinearIssueBrowser` in `singleSelect` — the same component the
 * app opened from the composer's Linear button.
 *
 * Attach then close IS the picker's whole contract. Nothing else finishes it:
 * the host's composer socket is waiting on the attach, and the surface stays up
 * until the page closes it.
 */

import React, { useCallback, useState } from "react";

import type { PluginWebviewContext } from "../bridge";
import { LinearIssueSelectModal } from "../components/LinearIssueSelectModal";
import { closeSurface, composerAttach, openSettings } from "../host/ui";
import type { LaneLinearIssue } from "../types";

export function PickerEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const projectRoot = context.project?.root ?? null;
  // The picker opens open. Dismissing it — Escape, the backdrop, the header's
  // close — is a request to close the PLACEMENT, not to leave an empty page
  // behind, so `onOpenChange(false)` routes to `closeSurface()`.
  const [open, setOpen] = useState(true);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) void closeSurface();
  }, []);

  const handleSelectIssue = useCallback((issue: LaneLinearIssue) => {
    setOpen(false);
    void (async () => {
      await composerAttach({
        provider: "linear",
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
      });
      await closeSurface();
    })();
  }, []);

  return (
    // The picker's own viewport is the frame the host sized, so
    // `LinearPaneModal`'s `min(940px, calc(100dvh - 28px))` /
    // `min(1760px, calc(100vw - 28px))` already sizes the pane to the PICKER
    // rather than to a desktop window — inside a guest those units are the
    // guest's. The `100dvh` box here is a sizing shim, not a ground: it paints
    // nothing, and it exists so a host that measures the document to size the
    // placement reads the picker's own height rather than the zero a `fixed`
    // portal would contribute.
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
        onOpenChange={handleOpenChange}
        onSelectIssue={handleSelectIssue}
        onOpenLinearSettings={() => void openSettings({ socketId: "connection" })}
      />
    </div>
  );
}
