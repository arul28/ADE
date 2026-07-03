import stringWidth from "string-width";

export type DisplayCluster = {
  text: string;
  start: number;
  end: number;
  width: number;
};

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export function terminalDisplayWidth(value: string): number {
  return stringWidth(value);
}

export function displayClusters(value: string): DisplayCluster[] {
  const clusters: DisplayCluster[] = [];
  if (segmenter) {
    for (const segment of segmenter.segment(value)) {
      const text = segment.segment;
      clusters.push({
        text,
        start: segment.index,
        end: segment.index + text.length,
        width: terminalDisplayWidth(text),
      });
    }
    return clusters;
  }
  let index = 0;
  for (const text of [...value]) {
    clusters.push({
      text,
      start: index,
      end: index + text.length,
      width: terminalDisplayWidth(text),
    });
    index += text.length;
  }
  return clusters;
}

export function codeUnitIndexForDisplayCell(value: string, cell: number): number {
  const target = Math.max(0, cell);
  let cells = 0;
  for (const cluster of displayClusters(value)) {
    if (target <= cells) return cluster.start;
    if (target < cells + cluster.width) return cluster.start;
    cells += cluster.width;
  }
  return value.length;
}

export function displayCellForCodeUnitIndex(value: string, index: number): number {
  const target = Math.max(0, Math.min(value.length, index));
  let cells = 0;
  for (const cluster of displayClusters(value)) {
    if (target <= cluster.start) return cells;
    if (target < cluster.end) return cells;
    cells += cluster.width;
  }
  return cells;
}

export function sliceByDisplayCells(value: string, startCell: number, endCell: number): string {
  const start = Math.max(0, startCell);
  const end = Math.max(start, endCell);
  let cells = 0;
  let output = "";
  for (const cluster of displayClusters(value)) {
    const next = cells + cluster.width;
    if (next > start && cells < end) output += cluster.text;
    cells = next;
  }
  return output;
}

export function splitByDisplayCells(
  value: string,
  startCell: number,
  endCell: number,
): { before: string; selected: string; after: string } {
  const start = Math.max(0, Math.min(startCell, terminalDisplayWidth(value)));
  const end = Math.max(start, Math.min(endCell, terminalDisplayWidth(value)));
  return {
    before: sliceByDisplayCells(value, 0, start),
    selected: sliceByDisplayCells(value, start, end),
    after: sliceByDisplayCells(value, end, Number.POSITIVE_INFINITY),
  };
}

export function truncateDisplayEnd(value: string, maxCells: number): string {
  if (terminalDisplayWidth(value) <= maxCells) return value;
  if (maxCells <= 1) return sliceByDisplayCells(value, 0, Math.max(0, maxCells));
  return `${sliceByDisplayCells(value, 0, maxCells - 1)}…`;
}

export function hardWrapDisplayText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const cluster of displayClusters(value)) {
    const clusterWidth = Math.max(0, cluster.width);
    if (current && currentWidth + clusterWidth > safeWidth) {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }
    current += cluster.text;
    currentWidth += clusterWidth;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}
