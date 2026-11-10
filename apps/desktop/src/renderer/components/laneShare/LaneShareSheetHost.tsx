import { LaneShareSheet } from "./LaneShareSheet";
import { closeLaneShareSheet, useLaneShareStore } from "./laneShareStore";

/** The one share sheet of the window, opened by `openLaneShareSheet` from any lane surface. */
export function LaneShareSheetHost() {
  const request = useLaneShareStore((s) => s.sheet);
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
