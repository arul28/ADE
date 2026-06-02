import React from "react";
import { FilesWorkbench } from "./v2/FilesWorkbench";

export type FilesTabProps = {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
};

export function FilesTab(props: FilesTabProps) {
  return <FilesWorkbench {...props} />;
}
