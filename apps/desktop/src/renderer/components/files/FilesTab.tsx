import React from "react";
import { useLocation } from "react-router-dom";
import { FilesWorkbench, type FilesNavigationOpenRequest } from "./v2/FilesWorkbench";
import type { OpenProjectBinding } from "../../../shared/types/core";

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
  openPathType?: unknown;
  /** Machine that owns the file, when it is not this tab's machine. */
  filesPin?: unknown;
  /** Set instead of a path when the clicked name matched several files. */
  searchQuery?: unknown;
};

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Accepts only the two real binding shapes; anything else resolves to null. */
function readOpenProjectBinding(value: unknown): OpenProjectBinding | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<OpenProjectBinding> & { kind?: unknown };
  if (typeof candidate.key !== "string" || typeof candidate.rootPath !== "string") return null;
  // `displayName` / `runtimeName` are read unguarded by the machine chip, so a
  // binding missing them would render a nameless machine.
  if (candidate.kind === "local") {
    return typeof candidate.displayName === "string" ? candidate as OpenProjectBinding : null;
  }
  if (candidate.kind !== "remote") return null;
  const remote = candidate as Extract<OpenProjectBinding, { kind: "remote" }>;
  return typeof remote.targetId === "string"
    && typeof remote.projectId === "string"
    && typeof remote.runtimeName === "string"
    ? remote
    : null;
}

export function FilesTab(props: FilesTabProps) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const navigationState = (location.state ?? null) as FilesNavigationState | null;
  const navigationOpenPath = typeof navigationState?.openFilePath === "string"
    ? navigationState.openFilePath
    : null;
  const navigationSearchQuery = typeof navigationState?.searchQuery === "string" && navigationState.searchQuery.length
    ? navigationState.searchQuery
    : null;
  // Router state is untrusted input like any other: only a shape that really is
  // a binding is forwarded, so a malformed history entry cannot aim file calls
  // at a machine that does not exist.
  const navigationPin = readOpenProjectBinding(navigationState?.filesPin);
  const navigationOpenRequest: FilesNavigationOpenRequest | null = navigationOpenPath || navigationSearchQuery
    ? {
        path: navigationOpenPath,
        laneId: typeof navigationState?.laneId === "string" ? navigationState.laneId : null,
        nonce: location.key,
        line: readPositiveInteger(navigationState?.startLine),
        column: readPositiveInteger(navigationState?.startColumn),
        pathType: navigationState?.openPathType === "directory" ? "directory" : "file",
        pin: navigationPin,
        ...(navigationSearchQuery ? { searchQuery: navigationSearchQuery } : {}),
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
