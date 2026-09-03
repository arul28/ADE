/**
 * The Linear browser, as a full-page tab.
 *
 * This is the placement the compiled `LinearIssueBrowserPane` filled: the whole
 * tab, three columns, the reader's whole workspace. Everything visual belongs to
 * `LinearIssueBrowser`, which is the compiled component moved rather than
 * rewritten; this file is only the wiring the app used to do around it —
 * the launch action, the settings jump, the batch launch and the lane conflicts.
 *
 * The launch flow is NOT written here. In the compiled app the Work-rail Linear
 * pane and the top-bar quick view both routed every 1..N issue launch through
 * the same `BatchLaunchModal`, so a reader configured the model, the kickoff
 * prompt, the branch and the lane target once, wherever they started from.
 * `useLinearBatchLaunch` is that flow, shared with `QuickViewEntry`; this entry
 * hands it to the browser and renders the two elements it returns. A tab-local
 * loop over `launchAgentOnIssue` would be a second implementation with its own
 * silent defaults for every one of those choices.
 */

import React, { useCallback, useState } from "react";

import type { PluginWebviewContext } from "../bridge";
import {
  LinearIssueBrowser,
  type BrowserIssue,
} from "../components/LinearIssueBrowser";
import { useLinearBatchLaunch } from "../components/LinearQuickViewPanel";
import { launchAgentOnIssue } from "../host/actions";
import { openSettings, toast } from "../host/ui";
import { useHostLanes } from "../host/useHostEntities";

export function BrowserEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const projectRoot = context.project?.root ?? null;
  const { lanes, refresh: refreshLanes } = useHostLanes();
  const [actionBusyIssueId, setActionBusyIssueId] = useState<string | null>(null);

  /**
   * The launch flow, and the duplicate guard that goes with it.
   *
   * `conflicts` comes from the hook's `findIssueConflicts`, which reads a
   * lane's own attachment AND the issues linked to sessions inside it, so
   * "this issue already has a lane" and "an agent is already working on this
   * issue" stay different sentences: the browser draws "Has lane" for the first
   * and "Has agent" for the second, and a session link wins when both hold.
   *
   * The status toast portals to `document.body` here. The tab's document is the
   * reader's whole workspace, which is the stage the compiled toast pinned
   * itself to; only the popover renders it inline.
   */
  const launch = useLinearBatchLaunch({
    projectRoot,
    lanes,
    refreshLanes,
    portalStatusToast: true,
  });

  const handleIssueAction = useCallback(async (issue: BrowserIssue) => {
    setActionBusyIssueId(issue.id);
    try {
      const result = await launchAgentOnIssue({ issueId: issue.id });
      if (result?.ok) {
        void toast({
          level: "success",
          message: `Started a lane on ${issue.identifier}.`,
        });
        refreshLanes();
      } else {
        void toast({
          level: "error",
          message: result?.message || `Could not start a lane on ${issue.identifier}.`,
        });
      }
    } catch (err) {
      void toast({
        level: "error",
        message: err instanceof Error ? err.message : `Could not start a lane on ${issue.identifier}.`,
      });
    } finally {
      setActionBusyIssueId(null);
    }
  }, [refreshLanes]);

  return (
    <div className="relative h-full min-h-0 flex flex-col">
      <LinearIssueBrowser
        projectRoot={projectRoot}
        actionLabel="Start a lane"
        actionBusyIssueId={actionBusyIssueId}
        onIssueAction={handleIssueAction}
        onOpenLinearSettings={() => void openSettings({ socketId: "connection" })}
        batchActions={{
          onBatchLaunch: launch.onBatchLaunch,
          batchProgress: launch.batchProgress,
          conflicts: launch.conflicts,
        }}
      />
      {launch.statusToast}
      {launch.launchModal}
    </div>
  );
}
