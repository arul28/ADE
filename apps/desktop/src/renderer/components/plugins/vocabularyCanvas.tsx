import React from "react";

import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { EmptyLine } from "./vocabularyPrimitives";
import type { VocabRenderContext } from "./vocabularyPrimitives";
import { VocabList } from "./vocabularyComponents";
import {
  bindingKey,
  boundRowEntries,
  coerceBoundListItem,
  VOCAB_LIMITS,
  type VocabAction,
  type VocabBinding,
  type VocabCanvasNode,
  type VocabListNode,
} from "../../../shared/plugins/vocabulary";
import { isRecord } from "../../../shared/plugins/parse";
import {
  buildCommitGraphLayout,
  columnCenterX,
  commitEdgePath,
  COMMIT_ROW_HEIGHT,
  rowCenterY,
} from "../history/commitGraphLayout";
import type { GitCommitSummary } from "../../../shared/types";

/**
 * Host-rendered canvas engines for vocabulary v1.
 *
 * The plugin never ships drawing code. It writes rows; this file picks an
 * engine ADE already owns and paints. Phone and terminal never reach here —
 * they draw the same bound rows as a list.
 */

export function VocabCanvas({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  switch (node.engine) {
    case "git-dag":
      return <GitDagCanvas node={node} context={context} />;
    case "swimlane":
      return <SwimlaneCanvas node={node} context={context} />;
    case "graph":
      return <GraphCanvas node={node} context={context} />;
    default: {
      const _exhaustive: never = node.engine;
      return <EmptyLine text={`Unknown canvas engine: ${String(_exhaustive)}`} />;
    }
  }
}

function GitDagCanvas({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  const entries = canvasEntries(node.bind, context, VOCAB_LIMITS.maxCanvasItems);
  const commits = entries
      .map((entry) => coerceGitDagCommit(entry.value, entry.key, node.bind.allowActions))
    .filter((row): row is GitDagRow => row !== null);

  if (commits.length === 0) {
    return <CanvasListFallback node={node} context={context} />;
  }

    return <GitDagView commits={commits} onSelect={(row) => dispatchCanvasSelect(row.id, row.onPress, node.onSelect, context)} />;
}

function SwimlaneCanvas({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  const entries = canvasEntries(node.bind, context, VOCAB_LIMITS.maxCanvasItems);
  const events = entries
      .map((entry) => coerceSwimlaneEvent(entry.value, entry.key, node.bind.allowActions))
    .filter((row): row is SwimlaneEvent => row !== null);

  if (events.length === 0) {
    return <CanvasListFallback node={node} context={context} />;
  }

  const lanes = uniqueLanes(events);
  return (
    <div
      data-vocab-canvas="swimlane"
      style={{
        display: "grid",
        gridTemplateColumns: `120px repeat(${Math.max(1, lanes.length)}, minmax(120px, 1fr))`,
        gap: 0,
        minHeight: 240,
        overflow: "auto",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 8,
        fontFamily: SANS_FONT,
      }}
    >
      <div style={headerCellStyle}>Event</div>
      {lanes.map((lane) => (
        <div key={lane.id} style={headerCellStyle}>
          {lane.name}
        </div>
      ))}
      {events.map((event) => (
        <React.Fragment key={event.id}>
          <button
            type="button"
            onClick={() => dispatchCanvasSelect(event.id, event.onPress, node.onSelect, context)}
            style={eventLabelStyle}
          >
            <span style={{ fontWeight: 500 }}>{event.title}</span>
            {event.subtitle ? (
              <span style={{ color: COLORS.textMuted, fontSize: 11 }}>{event.subtitle}</span>
            ) : null}
          </button>
          {lanes.map((lane) => (
            <div key={`${event.id}:${lane.id}`} style={laneCellStyle}>
              {event.laneId === lane.id ? (
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 99,
                    background: COLORS.accent,
                    display: "inline-block",
                  }}
                />
              ) : null}
            </div>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

function GraphCanvas({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  const nodeEntries = canvasEntries(node.bind, context, VOCAB_LIMITS.maxCanvasItems);
  const nodes = nodeEntries
      .map((entry) => coerceGraphNode(entry.value, entry.key, nodeEntries.length, node.bind.allowActions))
    .filter((row): row is GraphNodeRow => row !== null);
  const edgeEntries = node.edges
    ? canvasEntries(node.edges, context, VOCAB_LIMITS.maxCanvasItems)
    : [];
  const edges = edgeEntries
    .map((entry) => coerceGraphEdge(entry.value, entry.key))
    .filter((row): row is GraphEdgeRow => row !== null);

  if (nodes.length === 0) {
    return <CanvasListFallback node={node} context={context} />;
  }

  const width = 640;
  const height = Math.max(280, 80 + nodes.length * 28);
  return (
    <svg
      data-vocab-canvas="graph"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={Math.min(height, 520)}
      role="img"
      aria-label="Graph"
    >
      {edges.map((edge) => {
        const from = nodes.find((row) => row.id === edge.source);
        const to = nodes.find((row) => row.id === edge.target);
        if (!from || !to) return null;
        return (
          <line
            key={edge.id}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="rgba(255,255,255,0.2)"
            strokeWidth={1.5}
          />
        );
      })}
      {nodes.map((row) => (
        <g
          key={row.id}
          style={{ cursor: "pointer" }}
          onClick={() => dispatchCanvasSelect(row.id, row.onPress, node.onSelect, context)}
        >
          <circle cx={row.x} cy={row.y} r={10} fill={COLORS.accent} stroke="rgba(255,255,255,0.4)" />
          <text
            x={row.x + 16}
            y={row.y + 4}
            fill={COLORS.textPrimary}
            fontFamily={SANS_FONT}
            fontSize={12}
          >
            {row.title}
          </text>
        </g>
      ))}
    </svg>
  );
}

function GitDagView({
  commits,
  onSelect,
}: {
  commits: GitDagRow[];
  onSelect: (row: GitDagRow) => void;
}) {
  const layout = React.useMemo(
    () => buildCommitGraphLayout(commits.map((row) => row.commit)),
    [commits],
  );
  const nodeBySha = React.useMemo(
    () => new Map(layout.nodes.map((n) => [n.sha, n])),
    [layout.nodes],
  );
  const headSha = commits[0]?.commit.sha ?? null;

  return (
    <div
      data-vocab-canvas="git-dag"
      style={{
        position: "relative",
        minHeight: 280,
        height: "100%",
        overflow: "auto",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 8,
      }}
    >
      <div style={{ position: "relative", height: layout.totalHeight }}>
        <svg
          aria-hidden
          width={layout.graphWidth}
          height={layout.totalHeight}
          style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
        >
          {layout.edges.map((edge) => {
            const x1 = columnCenterX(edge.fromCol);
            const y1 = rowCenterY(edge.fromRow) + 4;
            const x2 = columnCenterX(edge.toCol);
            const y2 = rowCenterY(edge.toRow) - 4;
            return (
              <path
                key={edge.id}
                d={commitEdgePath(x1, y1, x2, y2)}
                fill="none"
                stroke={edge.kind === "merge" ? "rgba(59,130,246,0.55)" : "rgba(255,255,255,0.14)"}
                strokeWidth={edge.kind === "merge" ? 1.5 : 1}
                strokeDasharray={edge.kind === "merge" ? "3 2" : undefined}
              />
            );
          })}
          {layout.nodes.map((node) => {
            const color = node.isHead ? "#22C55E" : node.isMerge ? "#3B82F6" : null;
            return (
              <circle
                key={node.sha}
                cx={columnCenterX(node.column)}
                cy={rowCenterY(node.rowIndex)}
                r={node.isMerge ? 5 : 4}
                fill={color ?? "var(--color-card)"}
                stroke={color ?? "rgba(255,255,255,0.35)"}
                strokeWidth={2}
              />
            );
          })}
        </svg>
        {commits.map((row, index) => {
          const isHead = row.commit.sha === headSha;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onSelect(row)}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                height: COMMIT_ROW_HEIGHT,
                transform: `translateY(${index * COMMIT_ROW_HEIGHT}px)`,
                display: "flex",
                alignItems: "center",
                gap: 10,
                paddingLeft: layout.graphWidth + 8,
                paddingRight: 12,
                background: "transparent",
                border: "none",
                color: COLORS.textPrimary,
                fontFamily: SANS_FONT,
                fontSize: 12,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted, width: 64, flexShrink: 0 }}>
                {row.commit.shortSha}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.title}
                {isHead ? " · HEAD" : ""}
              </span>
              {row.refs.length > 0 ? (
                <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.accent, flexShrink: 0 }}>
                  {row.refs.join(" ")}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CanvasListFallback({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  const listNode: VocabListNode = {
    component: "list",
    bind: node.bind,
    ...(node.emptyText !== undefined ? { emptyText: node.emptyText } : {}),
  };
  return <VocabList node={listNode} context={context} />;
}

function canvasEntries(
  binding: VocabBinding,
  context: VocabRenderContext,
  cap: number,
): { key?: string; value: unknown }[] {
  const rows = boundRowEntries(
    { ...binding, limit: Math.min(binding.limit ?? cap, cap) },
    context.rowsByBinding.get(bindingKey(binding)),
    context.state,
  );
  return rows ?? [];
}

function dispatchCanvasSelect(
  id: string,
  rowAction: VocabAction | undefined,
  canvasAction: VocabAction | undefined,
  context: VocabRenderContext,
): void {
  const action = rowAction ?? (canvasAction
    ? { ...canvasAction, args: { ...canvasAction.args, id } }
    : null);
  if (!action) return;
  void context.dispatch(action);
}

type GitDagRow = {
  id: string;
  title: string;
  refs: string[];
  onPress?: VocabAction;
  commit: GitCommitSummary;
};

function coerceGitDagCommit(
  value: unknown,
  key: string | undefined,
  allowActions: readonly string[] | undefined,
): GitDagRow | null {
  if (!isRecord(value)) return null;
  const sha = readString(value.sha) ?? readString(value.id) ?? key;
  if (!sha) return null;
  const item = coerceBoundListItem(value, allowActions, key);
  const parents = Array.isArray(value.parents)
    ? value.parents.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const shortSha = readString(value.shortSha) ?? sha.slice(0, 7);
  const refs = Array.isArray(value.refs)
    ? value.refs.filter((entry): entry is string => typeof entry === "string").slice(0, 8)
    : [];
  return {
    id: sha,
    title: item?.title ?? readString(value.subject) ?? sha,
    refs,
    ...(item?.onPress !== undefined ? { onPress: item.onPress } : {}),
    commit: {
      sha,
      shortSha,
      parents,
      authorName: readString(value.authorName) ?? "",
      authoredAt: readString(value.authoredAt) ?? "",
      subject: item?.title ?? readString(value.subject) ?? sha,
      pushed: value.pushed === true,
    },
  };
}

type SwimlaneEvent = {
  id: string;
  title: string;
  subtitle?: string;
  laneId: string;
  laneName: string;
  onPress?: VocabAction;
};

function coerceSwimlaneEvent(
  value: unknown,
  key: string | undefined,
  allowActions: readonly string[] | undefined,
): SwimlaneEvent | null {
  if (!isRecord(value)) return null;
  const item = coerceBoundListItem(value, allowActions, key);
  const id = item?.key ?? readString(value.id) ?? key;
  const laneId = readString(value.laneId);
  if (!id || !laneId) return null;
  return {
    id,
    title: item?.title ?? id,
    ...(item?.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
    laneId,
    laneName: readString(value.laneName) ?? laneId,
    ...(item?.onPress !== undefined ? { onPress: item.onPress } : {}),
  };
}

function uniqueLanes(events: SwimlaneEvent[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const event of events) {
    if (!seen.has(event.laneId)) seen.set(event.laneId, event.laneName);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

type GraphNodeRow = {
  id: string;
  title: string;
  x: number;
  y: number;
  onPress?: VocabAction;
};

type GraphEdgeRow = { id: string; source: string; target: string };

function coerceGraphNode(
  value: unknown,
  key: string | undefined,
  count: number,
  allowActions: readonly string[] | undefined,
): GraphNodeRow | null {
  if (!isRecord(value)) return null;
  const item = coerceBoundListItem(value, allowActions, key);
  const id = item?.key ?? readString(value.id) ?? key;
  if (!id) return null;
  const index = Number.parseInt(key?.replace(/\D/g, "") || "0", 10);
  const col = count <= 1 ? 0 : index % Math.ceil(Math.sqrt(count));
  const row = count <= 1 ? 0 : Math.floor(index / Math.max(1, Math.ceil(Math.sqrt(count))));
  const x = typeof value.x === "number" && Number.isFinite(value.x) ? value.x : 80 + col * 140;
  const y = typeof value.y === "number" && Number.isFinite(value.y) ? value.y : 48 + row * 72;
  return {
    id,
    title: item?.title ?? id,
    x,
    y,
    ...(item?.onPress !== undefined ? { onPress: item.onPress } : {}),
  };
}

function coerceGraphEdge(value: unknown, key?: string): GraphEdgeRow | null {
  if (!isRecord(value)) return null;
  const source = readString(value.source) ?? readString(value.from);
  const target = readString(value.target) ?? readString(value.to);
  if (!source || !target) return null;
  return { id: key ?? `${source}->${target}`, source, target };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const headerCellStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  padding: "8px 10px",
  fontSize: 11,
  fontWeight: 600,
  color: COLORS.textMuted,
  background: COLORS.recessedBg,
  borderBottom: `1px solid ${COLORS.borderMuted}`,
};

const eventLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  padding: "8px 10px",
  background: "transparent",
  border: "none",
  borderBottom: `1px solid ${COLORS.borderMuted}`,
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
};

const laneCellStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderBottom: `1px solid ${COLORS.borderMuted}`,
  borderLeft: `1px solid ${COLORS.borderMuted}`,
};
