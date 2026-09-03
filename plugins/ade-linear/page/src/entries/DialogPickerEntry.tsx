/**
 * The issue picker inside one of ADE's own dialogs.
 *
 * The `dialog-picker` placement, opened by the manifest's two `dialog-section`
 * sockets — one on Create lane, one on Create PR. Those are the two places the
 * compiled Linear drew an issue picker that this page tier could not reach at
 * all: a dialog section is a band inside a dialog ADE owns, and until the
 * placement existed the pickers stayed on the vocabulary panel.
 *
 * What makes this entry different from `PickerEntry`, which it otherwise
 * resembles: the dialog is WAITING on it. A composer picker attaches a chip and
 * closes itself, and the composer is none the wiser if it never does. A dialog
 * section is a field in a form the reader is filling in, so the answer goes back
 * through `dialog.submit({ issue })` and the dialog writes the issue into its
 * own fields — the lane's name and branch, the PR's title and body.
 *
 * There is no Cancel here, and its absence is the point. The dialog around this
 * page has its own, and a second one inside a band of that dialog would be two
 * buttons for one gesture with different meanings behind them.
 *
 * The browser is drawn INLINE rather than inside `LinearIssueSelectModal`. A
 * modal over a dialog is two layers of chrome for one choice, and the host has
 * already given this page a band to draw in.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import type { PluginWebviewContext } from "../bridge";
import { LinearIssueBrowser, linearBrowserIssueToLaneIssue } from "../components/LinearIssueBrowser";
import type { BrowserIssue } from "../components/LinearIssueBrowser";
import { openSettings, reportHeight, submitDialog } from "../host/ui";

/**
 * The dialog this section is drawn in, from the host's own context.
 *
 * `subject.kind` is `"dialog"` and `subject.dialog` names which one. Anything
 * else falls through to `create-lane`: it is the commoner of the two, and the
 * only thing that turns on the answer is a label and whether the branch preview
 * is worth drawing.
 */
function dialogKind(context: PluginWebviewContext): "create-lane" | "create-pr" {
  const named = typeof context.subject?.dialog === "string" ? context.subject.dialog : null;
  return named === "create-pr" ? "create-pr" : "create-lane";
}

export function DialogPickerEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const kind = dialogKind(context);
  const projectRoot = context.project?.root ?? null;
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastReportedRef = useRef<number | null>(null);

  // A dialog section is sized to its content, like the settings section: the
  // dialog owns the scrollport around it, and `ui.resize` is the only channel.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const report = () => {
      const measured = node.getBoundingClientRect().height;
      if (measured === lastReportedRef.current) return;
      if (reportHeight(measured) !== null) lastReportedRef.current = measured;
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleIssueAction = useCallback((row: BrowserIssue) => {
    // Guarded rather than debounced: `submit` closes the dialog around this
    // page, and a second press landing in that gap would be answering a dialog
    // that has already taken an issue.
    if (busyIssueId) return;
    const issue = linearBrowserIssueToLaneIssue(row);
    setBusyIssueId(issue.id);
    void (async () => {
      const taken = await submitDialog({
        provider: "linear",
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
      });
      // A host that answered nothing has no dialog to fill in. Releasing the
      // guard leaves the reader able to try again rather than stuck on a dead
      // list.
      if (!taken) setBusyIssueId(null);
    })();
  }, [busyIssueId]);

  return (
    <div ref={rootRef}>
      <LinearIssueBrowser
        projectRoot={projectRoot}
        singleSelect
        actionLabel={kind === "create-pr" ? "Use for this PR" : "Use for this lane"}
        actionBusyLabel="Adding issue"
        actionBusyIssueId={busyIssueId}
        // The branch name is what a lane is cut on, so it is worth previewing
        // there and is noise on a PR whose branch already exists.
        showBranchPreview={kind === "create-lane"}
        onIssueAction={handleIssueAction}
        onOpenLinearSettings={() => void openSettings({ socketId: "connection" })}
      />
    </div>
  );
}
