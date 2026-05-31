import React from "react";
import { isFilesWorkbenchV2Enabled } from "./filesWorkbenchFlag";
import { FilesPage } from "./FilesPage";
import { FilesWorkbench } from "./v2/FilesWorkbench";

export type FilesTabProps = {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
};

/**
 * Entry point for the Files tab. Renders the v2 workbench when the
 * FILES_WORKBENCH_V2 flag is enabled, otherwise the current FilesPage. Branching
 * here keeps both the route (App.tsx) and the embedded sidebar (WorkSidebar) on
 * one switch so the default experience is unchanged until the flag flips.
 */
export function FilesTab(props: FilesTabProps) {
  if (isFilesWorkbenchV2Enabled()) {
    return <FilesWorkbench {...props} />;
  }
  return <FilesPage {...props} />;
}
