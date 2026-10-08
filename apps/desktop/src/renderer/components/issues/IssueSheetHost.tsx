import { useCallback, useEffect, useState } from "react";
import { issueRefLabel, type IssueRef } from "../../../shared/issueRefs";
import {
  clearPendingIssueSheetRequest,
  subscribeIssueSheetRequests,
  takePendingIssueSheetRequest,
  type IssueOpenRequest,
} from "../../lib/issueNavigation";
import { requestGitHubIssuesPaneOpen } from "../../lib/githubIssuesPaneRequests";
import { requestLinearPaneOpen } from "../../lib/linearIssueQuickViewNavigation";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { Dialog } from "../ui/dialog";
import { IssueViewer } from "./IssueViewer";

/** Wide enough for the two-column layout; the sheet never covers more than it needs. */
const SHEET_WIDTH = 760;

/**
 * The issue sheet: one issue, floating over whatever page you are on, opened
 * from places that have no Work tools pane (Lanes, PRs, the command palette, a
 * deeplink). Mounted once in the app shell.
 *
 * Opening a related issue from inside the sheet replaces what it shows rather
 * than stacking sheets; Esc or the scrim closes it.
 */
export function IssueSheetHost() {
  const [request, setRequest] = useState<IssueOpenRequest | null>(null);

  useEffect(() => {
    const pending = takePendingIssueSheetRequest();
    if (pending) setRequest(pending);
    return subscribeIssueSheetRequests((next) => {
      clearPendingIssueSheetRequest();
      setRequest(next);
    });
  }, []);

  // The built-in browser is a native view drawn above the DOM; while the sheet
  // is up it must step aside or it would paint over the sheet.
  const open = request != null;
  useEffect(() => {
    if (!open) return undefined;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [open]);

  const close = useCallback(() => setRequest(null), []);
  const openRelated = useCallback((ref: IssueRef) => setRequest({ ref, source: "issue-viewer" }), []);
  const provider = request?.ref.provider ?? null;
  const viewAll = useCallback(() => {
    setRequest(null);
    if (provider === "github") requestGitHubIssuesPaneOpen();
    else requestLinearPaneOpen();
  }, [provider]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={request ? `Issue ${issueRefLabel(request.ref)}` : "Issue"}
      hideHeader
      placement="right"
      width={SHEET_WIDTH}
      bodyPadding={false}
      scrollBody={false}
      preventAutoFocus
      testId="issue-sheet"
    >
      {request ? (
        <IssueViewer
          issueRef={request.ref}
          variant="sheet"
          onOpenRelated={openRelated}
          onViewAll={viewAll}
          onClose={close}
        />
      ) : null}
    </Dialog>
  );
}
