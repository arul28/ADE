import React, { useMemo } from "react";
import {
  columnCenterX,
  commitEdgePathD,
  type CommitGraphEdge,
  type CommitGraphLayout,
} from "./commitGraphLayout";

/** Rows per SVG tile. Tiles are memoized, so scrolling only mounts new ones. */
const TILE_ROWS = 40;

export type GraphPaint = {
  /** Owner key per commit sha; hover focus groups by it. */
  ownerOf: (sha: string) => string;
  colorOf: (ownerKey: string) => string;
  headSha: string | null;
};

function edgeOwner(edge: CommitGraphEdge, paint: GraphPaint, gap: CommitGraphLayout["gap"]): string {
  // A merge edge belongs to the branch being merged in. An edge that crosses
  // the lane/base divider belongs to the base below it, so the lane's colour
  // stops at the lane's oldest commit.
  if (edge.kind === "merge") return paint.ownerOf(edge.toSha);
  if (gap && edge.fromRow <= gap.afterRow && edge.toRow > gap.afterRow) return paint.ownerOf(edge.toSha);
  return paint.ownerOf(edge.fromSha);
}

type Tile = { index: number; edges: CommitGraphEdge[] };

function buildTiles(layout: CommitGraphLayout): Tile[] {
  const rowCount = layout.nodes.length;
  const tileCount = Math.ceil(rowCount / TILE_ROWS);
  const tiles: Tile[] = Array.from({ length: tileCount }, (_, index) => ({ index, edges: [] }));
  for (const edge of layout.edges) {
    const first = Math.floor(edge.fromRow / TILE_ROWS);
    const last = Math.floor(Math.min(edge.toRow, rowCount - 1) / TILE_ROWS);
    for (let tile = first; tile <= last && tile < tileCount; tile += 1) tiles[tile]!.edges.push(edge);
  }
  return tiles;
}

const GraphTile = React.memo(function GraphTile({
  tile,
  layout,
  paint,
}: {
  tile: Tile;
  layout: CommitGraphLayout;
  paint: GraphPaint;
}) {
  const firstRow = tile.index * TILE_ROWS;
  const nodes = layout.nodes.slice(firstRow, firstRow + TILE_ROWS);
  const top = layout.rowTop(firstRow);
  const height = layout.rowTop(firstRow + TILE_ROWS) - top;
  return (
    <svg
      className="chv-tile pointer-events-none absolute left-0"
      style={{ top }}
      width={layout.graphWidth}
      height={height}
      aria-hidden
    >
      <g transform={`translate(0 ${-top})`}>
        {tile.edges.map((edge) => {
          const owner = edgeOwner(edge, paint, layout.gap);
          const d = commitEdgePathD(edge, layout);
          return (
            <g key={edge.id} data-owner={owner}>
              <path
                className="chv-edge"
                d={d}
                fill="none"
                stroke={paint.colorOf(owner)}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray={edge.folded > 0 ? "1.5 3.5" : undefined}
              />
              <path
                className="chv-hit"
                data-owner={owner}
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={10}
                style={{ pointerEvents: "stroke" }}
              >
                {edge.folded > 0 ? <title>{`${edge.folded} commit${edge.folded === 1 ? "" : "s"} folded`}</title> : null}
              </path>
            </g>
          );
        })}
        {nodes.map((node) => {
          const owner = paint.ownerOf(node.sha);
          const color = paint.colorOf(owner);
          const cx = columnCenterX(node.column);
          const cy = layout.rowCenter(node.rowIndex);
          const isHead = node.sha === paint.headSha;
          const local = !node.commit.pushed;
          return (
            <g key={node.sha} data-owner={owner} className="chv-node">
              {isHead ? (
                <circle cx={cx} cy={cy} r={6.5} fill="none" stroke={color} strokeWidth={1.25} opacity={0.75} />
              ) : null}
              <circle
                cx={cx}
                cy={cy}
                r={node.isMerge ? 3 : 3.75}
                fill={local ? "var(--color-bg)" : color}
                stroke={local ? color : "var(--color-bg)"}
                strokeWidth={local ? 1.5 : 1.25}
              />
              <circle
                className="chv-hit"
                data-owner={owner}
                data-row={node.rowIndex}
                cx={cx}
                cy={cy}
                r={8}
                fill="transparent"
                style={{ pointerEvents: "all", cursor: "pointer" }}
              >
                <title>{local ? "Not pushed" : node.isMerge ? "Merge" : node.commit.shortSha}</title>
              </circle>
            </g>
          );
        })}
      </g>
    </svg>
  );
});

/**
 * The commit graph, drawn as row tiles above the rows. Only tiles that touch
 * the rendered row range mount; each is memoized on the layout, so scrolling
 * never redraws a tile that is already on screen.
 */
export function CommitGraphLayer({
  layout,
  paint,
  firstRow,
  lastRow,
  width,
}: {
  layout: CommitGraphLayout;
  paint: GraphPaint;
  firstRow: number;
  lastRow: number;
  /** Visible width; lanes past it are clipped. */
  width: number;
}) {
  const tiles = useMemo(() => buildTiles(layout), [layout]);
  if (layout.nodes.length === 0) return null;
  const firstTile = Math.max(0, Math.floor(firstRow / TILE_ROWS));
  const lastTile = Math.min(tiles.length - 1, Math.floor(lastRow / TILE_ROWS));
  const visible: Tile[] = [];
  for (let index = firstTile; index <= lastTile; index += 1) visible.push(tiles[index]!);
  return (
    <div className="chv-graph pointer-events-none absolute left-0 top-0 z-[1] overflow-hidden" style={{ width, height: layout.totalHeight }}>
      {visible.map((tile) => (
        <GraphTile key={tile.index} tile={tile} layout={layout} paint={paint} />
      ))}
    </div>
  );
}

/**
 * Hover focus without React renders: the scroll root carries the focused
 * owner and one generated rule dims everything else.
 */
export function applyGraphFocus(root: HTMLElement | null, styleEl: HTMLStyleElement | null, owner: string | null): void {
  if (!root || !styleEl) return;
  if ((root.dataset.focus ?? null) === owner) return;
  if (owner == null) {
    delete root.dataset.focus;
    styleEl.textContent = "";
    return;
  }
  root.dataset.focus = owner;
  const key = CSS.escape(owner);
  styleEl.textContent = [
    `.chv[data-focus] .chv-tile [data-owner]:not([data-owner="${key}"]) { opacity: 0.24; }`,
    `.chv[data-focus] .chv-tile g[data-owner="${key}"] > .chv-edge { stroke-width: 2.25px; }`,
    `.chv[data-focus] .chv-row:not([data-owner="${key}"]) { opacity: 0.45; }`,
  ].join("\n");
}
