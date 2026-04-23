import type { PaneLayoutEntry, PaneSplit } from "../ui/PaneTilingLayout";

const MIN_PANE_SIZE = 8;
const MIN_ROW_SIZE = 12;

function createPaneEntry(id: string, defaultSize?: number): PaneLayoutEntry {
  return {
    node: { type: "pane", id },
    defaultSize,
    minSize: MIN_PANE_SIZE,
  };
}

function distributeCounts(total: number, bucketCount: number): number[] {
  if (total <= 0 || bucketCount <= 0) return [];
  const base = Math.floor(total / bucketCount);
  const remainder = total % bucketCount;
  return Array.from({ length: bucketCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function buildWorkSessionTilingTree(sessionIds: string[]): PaneSplit {
  if (sessionIds.length <= 1) {
    return {
      type: "split",
      direction: "vertical",
      children: sessionIds.map((id) => ({
        node: { type: "pane", id },
        defaultSize: 100,
        minSize: MIN_ROW_SIZE,
      })),
    };
  }

  const columnCount = Math.ceil(Math.sqrt(sessionIds.length));
  const rowCount = Math.ceil(sessionIds.length / columnCount);
  const rowSizes = distributeCounts(sessionIds.length, rowCount);

  if (rowCount === 1) {
    return {
      type: "split",
      direction: "horizontal",
      children: sessionIds.map((id) => createPaneEntry(id, 100 / sessionIds.length)),
    };
  }

  let offset = 0;
  return {
    type: "split",
    direction: "vertical",
    children: rowSizes.map((rowSize) => {
      const rowIds = sessionIds.slice(offset, offset + rowSize);
      offset += rowSize;
      if (rowIds.length === 1) {
        return {
          node: { type: "pane", id: rowIds[0]! },
          defaultSize: 100 / rowCount,
          minSize: MIN_ROW_SIZE,
        };
      }
      return {
        node: {
          type: "split",
          direction: "horizontal",
          children: rowIds.map((id) => createPaneEntry(id, 100 / rowIds.length)),
        },
        defaultSize: 100 / rowCount,
        minSize: MIN_ROW_SIZE,
      };
    }),
  };
}
