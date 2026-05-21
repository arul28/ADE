import React from "react";
import { Text } from "ink";

function mapFor(count: number, focusedIndex: number): string {
  const cells = Array.from({ length: Math.max(1, Math.min(6, count)) }, (_, index) => (
    index === focusedIndex ? "▣" : "▢"
  ));
  if (cells.length <= 3) return cells.join("");
  if (cells.length === 4) return `${cells.slice(0, 2).join("")} / ${cells.slice(2).join("")}`;
  return `${cells.slice(0, cells.length === 5 ? 2 : 3).join("")} / ${cells.slice(cells.length === 5 ? 2 : 3).join("")}`;
}

export function gridMiniMapText(count: number, focusedIndex: number): string {
  if (count <= 1) return "▣";
  return mapFor(count, Math.max(0, Math.min(focusedIndex, count - 1)));
}

export function GridMiniMap({
  count,
  focusedIndex,
}: {
  count: number;
  focusedIndex: number;
}) {
  return <Text>{gridMiniMapText(count, focusedIndex)}</Text>;
}
