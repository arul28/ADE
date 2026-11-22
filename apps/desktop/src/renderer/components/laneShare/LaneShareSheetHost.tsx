import { useEffect } from "react";
import { LaneShareSheet } from "./LaneShareSheet";
import { installAgentShareNotices } from "./laneShareAgentNotice";
import { closeLaneShareSheet, useLaneShareStore } from "./laneShareStore";

/**
 * The one share sheet of the window, opened by `openLaneShareSheet` from any
 * lane surface. It also installs the window's notice for a share an agent made.
 */
export function LaneShareSheetHost() {
  const request = useLaneShareStore((s) => s.sheet);
  useEffect(() => installAgentShareNotices(), []);
  if (!request) return null;
  return (
    <LaneShareSheet
      // A new lane or machine is a new sheet, with fresh drafts.
      key={`${request.listKey ?? ""}:${request.laneId}`}
      request={request}
      onClose={closeLaneShareSheet}
    />
  );
}
