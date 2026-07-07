import React from "react";
import { useLocation } from "react-router-dom";
import { FilesWorkbench } from "./v2/FilesWorkbench";

export type FilesTabProps = {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
};

export function FilesTab(props: FilesTabProps) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  return (
    <FilesWorkbench
      {...props}
      externalOpenPath={params.get("externalPath")}
      externalOpenNonce={params.get("externalOpen")}
      externalOpenLine={params.get("line")}
    />
  );
}
