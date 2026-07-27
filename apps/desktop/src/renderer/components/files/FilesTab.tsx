import React from "react";
import { useLocation } from "react-router-dom";
import { FilesWorkbench, type FilesNavigationOpenRequest } from "./v2/FilesWorkbench";

export type FilesTabProps = {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
};

type FilesNavigationState = {
  openFilePath?: unknown;
  laneId?: unknown;
  startLine?: unknown;
  startColumn?: unknown;
};

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function FilesTab(props: FilesTabProps) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const navigationState = (location.state ?? null) as FilesNavigationState | null;
  const navigationOpenPath = typeof navigationState?.openFilePath === "string"
    ? navigationState.openFilePath
    : null;
  const navigationOpenRequest: FilesNavigationOpenRequest | null = navigationOpenPath
    ? {
        path: navigationOpenPath,
        laneId: typeof navigationState?.laneId === "string" ? navigationState.laneId : null,
        nonce: location.key,
        line: readPositiveInteger(navigationState?.startLine),
        column: readPositiveInteger(navigationState?.startColumn),
      }
    : null;
  return (
    <FilesWorkbench
      {...props}
      externalOpenPath={params.get("externalPath")}
      externalOpenNonce={params.get("externalOpen")}
      externalOpenLine={params.get("line")}
      navigationOpenRequest={navigationOpenRequest}
    />
  );
}
