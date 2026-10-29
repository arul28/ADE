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

/** Pad with spaces so the string occupies exactly `width` terminal cells. */
export function padDisplayEnd(value: string, width: number): string {
  const used = terminalDisplayWidth(value);
  if (used >= width) return value;
  return value + " ".repeat(width - used);
}

