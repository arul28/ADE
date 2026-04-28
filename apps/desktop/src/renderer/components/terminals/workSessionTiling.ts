import type { PaneLayoutEntry, PaneSplit } from "../ui/PaneTilingLayout";

const MIN_PANE_SIZE = 8;
const MIN_ROW_SIZE = 12;

export type TilingPreset = "auto" | "rows" | "columns";

function paneEntry(id: string, defaultSize: number, minSize: number): PaneLayoutEntry {
  return { node: { type: "pane", id }, defaultSize, minSize };
}

function rowSizes(total: number, rowCount: number): number[] {
  const base = Math.floor(total / rowCount);
  const remainder = total % rowCount;
  return Array.from({ length: rowCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function buildWorkSessionTilingTree(
  sessionIds: string[],
  preset: TilingPreset = "auto",
): PaneSplit {
  if (sessionIds.length <= 1) {
    return {
      type: "split",
      direction: "vertical",
      children: sessionIds.map((id) => paneEntry(id, 100, MIN_ROW_SIZE)),
    };
  }

  if (preset === "rows") {
    return {
      type: "split",
      direction: "vertical",
      children: sessionIds.map((id) => paneEntry(id, 100 / sessionIds.length, MIN_ROW_SIZE)),
    };
  }

  if (preset === "columns") {
    return {
      type: "split",
      direction: "horizontal",
      children: sessionIds.map((id) => paneEntry(id, 100 / sessionIds.length, MIN_PANE_SIZE)),
    };
  }

  const columnCount = Math.ceil(Math.sqrt(sessionIds.length));
  const rowCount = Math.ceil(sessionIds.length / columnCount);

  if (rowCount === 1) {
    return {
      type: "split",
      direction: "horizontal",
      children: sessionIds.map((id) => paneEntry(id, 100 / sessionIds.length, MIN_PANE_SIZE)),
    };
  }

  let offset = 0;
  return {
    type: "split",
    direction: "vertical",
    children: rowSizes(sessionIds.length, rowCount).map((rowSize) => {
      const rowIds = sessionIds.slice(offset, offset + rowSize);
      offset += rowSize;
      if (rowIds.length === 1) {
        return paneEntry(rowIds[0]!, 100 / rowCount, MIN_ROW_SIZE);
      }
      return {
        node: {
          type: "split",
          direction: "horizontal",
          children: rowIds.map((id) => paneEntry(id, 100 / rowIds.length, MIN_PANE_SIZE)),
        },
        defaultSize: 100 / rowCount,
        minSize: MIN_ROW_SIZE,
      };
    }),
  };
}
