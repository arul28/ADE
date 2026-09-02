import React from "react";

import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { EmptyLine, InlineError } from "./vocabularyPrimitives";
import type { VocabRenderContext } from "./vocabularyPrimitives";
import { VocabList, VocabListPageRow, useVocabActionRunner } from "./vocabularyComponents";
import {
  bindingKey,
  boundRowEntries,
  coerceBoundListItem,
  vocabListPage,
  vocabListPageLabel,
  VOCAB_LIMITS,
  type VocabAction,
  type VocabBinding,
  type VocabCanvasNode,
  type VocabListNode,
} from "../../../shared/plugins/vocabulary";
import { PLUGIN_BUILTIN_SURFACE_OWNER_IDS } from "../../../shared/plugins/builtinSurfaceRegistry";
import { isRecord } from "../../../shared/plugins/parse";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import {
  buildCommitGraphLayout,
  columnCenterX,
  commitEdgePath,
  COMMIT_ROW_HEIGHT,
  rowCenterY,
} from "../history/commitGraphLayout";
import type { GitCommitSummary } from "../../../shared/types";

const WorkspaceGraphPage = React.lazy(() =>
  import("../graph/WorkspaceGraphPage").then((module) => ({
    default: module.WorkspaceGraphPage,
  })),
);

const ChatAppControlPanel = React.lazy(() =>
  import("../chat/ChatAppControlPanel").then((module) => ({
    default: module.ChatAppControlPanel,
  })),
);

const ChatIosSimulatorPanel = React.lazy(() =>
  import("../chat/ChatIosSimulatorPanel").then((module) => ({
    default: module.ChatIosSimulatorPanel,
  })),
);

/**
 * Host-rendered canvas engines for vocabulary v1.
 *
 * The plugin never ships drawing code. It writes rows; this file picks an
 * engine ADE already owns and paints. Phone and terminal never reach here —
 * they draw the same bound rows as a list. `workspace`, `electron-control` and
 * `simulator` are compiled host pages: desktop mounts them; other clients still
 * list the bound rows.
 *
 * ## Who may name a compiled host page
 *
 * `git-dag`, `swimlane` and `graph` are drawing engines over rows the plugin
 * wrote, so every plugin may name them. The other three are not engines: each
 * one mounts a compiled ADE pane that reads the host's OWN state — the
 * workspace topology, a Chrome DevTools session, a booted simulator — and none
 * of that comes from the plugin's rows. A plugin that could name `simulator`
 * would get simctl streaming into its panel without asking for the capability.
 *
 * So a compiled page is drawn only for the plugin registered as its owner in
 * {@link PLUGIN_BUILTIN_SURFACE_OWNER_IDS}, which is the same table that decides
 * which plugin supersedes which compiled surface. Every other plugin gets the
 * honest fallback: the bound rows drawn as a list, exactly what the phone and
 * the terminal draw for the same node. The parser stays open on purpose — it is
 * shared with clients that have no host page to protect and no plugin id to
 * check — so the refusal lives here, at the mount.
 */

/**
 * The plugin each compiled host page belongs to.
 *
 * Read out of the surface-owner table rather than spelled again, so a surface
 * that changes hands changes hands here too.
 */
const HOST_ENGINE_OWNER_PLUGIN_ID: Readonly<
  Record<"workspace" | "electron-control" | "simulator", string>
> = {
  workspace: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.graph,
  "electron-control": PLUGIN_BUILTIN_SURFACE_OWNER_IDS["app-control"],
  simulator: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.ios,
};

/** True when the publishing plugin owns the compiled page this engine mounts. */
export function canMountHostCanvasEngine(
  engine: "workspace" | "electron-control" | "simulator",
  pluginId: string,
): boolean {
  return HOST_ENGINE_OWNER_PLUGIN_ID[engine] === pluginId;
}

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
    case "workspace":
      return canMountHostCanvasEngine("workspace", context.pluginId)
        ? <WorkspaceCanvas context={context} />
        : <CanvasListFallback node={node} context={context} />;
    case "electron-control":
      return canMountHostCanvasEngine("electron-control", context.pluginId)
        ? <HostEngineCanvas engine="electron-control" context={context} />
        : <CanvasListFallback node={node} context={context} />;
    case "simulator":
      return canMountHostCanvasEngine("simulator", context.pluginId)
        ? <HostEngineCanvas engine="simulator" context={context} />
        : <CanvasListFallback node={node} context={context} />;
    default: {
      const _exhaustive: never = node.engine;
      return <EmptyLine text={`Unknown canvas engine: ${String(_exhaustive)}`} />;
    }
  }
}

function WorkspaceCanvas({ context }: { context: VocabRenderContext }) {
  // Bind is required by the parser so phone and TUI list the same lanes. Desktop
  // mounts ADE's compiled Graph page and reads topology from the host store.
  return (
    <div
      data-vocab-canvas="workspace"
      style={{
        flex: 1,
        minHeight: 560,
        minWidth: 0,
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <React.Suspense fallback={<EmptyLine text="Loading Graph…" />}>
        <WorkspaceGraphPage active={context.active} />
      </React.Suspense>
    </div>
  );
}

function HostEngineCanvas({
  engine,
  context,
}: {
  engine: "electron-control" | "simulator";
  context: VocabRenderContext;
}) {
  // Bind is required so phone and TUI list the same status rows. Desktop mounts
  // the compiled pane ADE already owns. Work rail still wires chat context
  // itself when these plugins contribute a work-rail-pane; this path is the
  // vocabulary mount (tests, a plugin tab, a deeplink).
  const label = engine === "electron-control" ? "Electron Control" : "iOS Simulator";
  const binding = useAppStore((state) => state.projectBinding);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  // The same pin the Work rail hands these two panes. A remote checkout is
  // owned by another machine, and a pane mounted with no pin asks the LOCAL
  // host for a CDP session or a booted simulator — so a remote project used to
  // report this machine's state under a remote project's tab. A local binding
  // needs no pin: the bound machine is this one.
  const runtimePin = binding?.kind === "remote" ? binding : null;

  let body: React.ReactNode;
  if (!binding) {
    // No project is open, so no machine is known. Saying so is the honest
    // answer; binding to whatever host happens to be local is not.
    body = (
      <EmptyLine text={`Open a project before using ${label}. ADE cannot tell which machine this pane belongs to.`} />
    );
  } else if (!context.active) {
    // The hidden-but-mounted perf law. Both panes stream — CDP frames for
    // Control, a simulator screen for Simulator — and a plugin tab the reader
    // has switched away from stays mounted, so the mount itself is the gate.
    body = <EmptyLine text={`${label} is paused while this tab is hidden.`} />;
  } else {
    body = (
      <React.Suspense fallback={<EmptyLine text={`Loading ${label}…`} />}>
        {engine === "electron-control" ? (
          <ChatAppControlPanel
            sessionId={null}
            laneId={null}
            runtimePin={runtimePin}
            projectRoot={projectRoot}
            controlDisabledReason={null}
          />
        ) : (
          <ChatIosSimulatorPanel
            sessionId={null}
            laneId={null}
            runtimePin={runtimePin}
            projectRoot={projectRoot}
            controlDisabledReason={null}
            // There is no chat behind a vocabulary canvas, so there is no chat
            // that could own the pane. The Work rail passes the same flag for
            // the same reason.
            ignoreChatOwnership
          />
        )}
      </React.Suspense>
    );
  }

  return (
    <div
      data-vocab-canvas={engine}
      data-vocab-canvas-active={context.active ? "true" : "false"}
      style={{
        flex: 1,
        minHeight: 560,
        minWidth: 0,
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {body}
    </div>
  );
}

function GitDagCanvas({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  const { entries, footer } = useCanvasPage(node.bind, context);
  const { select, error } = useCanvasSelect(node, context);
  const commits = entries
      .map((entry) => coerceGitDagCommit(entry.value, entry.key, node.bind.allowActions))
    .filter((row): row is GitDagRow => row !== null);

  if (commits.length === 0) {
    return <CanvasListFallback node={node} context={context} />;
  }

  return (
    <CanvasFrame footer={footer} error={error}>
      <GitDagView commits={commits} onSelect={(row) => select(row.id, row.onPress)} />
    </CanvasFrame>
  );
}

function SwimlaneCanvas({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  const { entries, footer } = useCanvasPage(node.bind, context);
  const { select, error } = useCanvasSelect(node, context);
  const events = entries
      .map((entry) => coerceSwimlaneEvent(entry.value, entry.key, node.bind.allowActions))
    .filter((row): row is SwimlaneEvent => row !== null);

  if (events.length === 0) {
    return <CanvasListFallback node={node} context={context} />;
  }

  const lanes = uniqueLanes(events);
  return (
    <CanvasFrame footer={footer} error={error}>
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
            onClick={() => select(event.id, event.onPress)}
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
    </CanvasFrame>
  );
}

function GraphCanvas({
  node,
  context,
}: {
  node: VocabCanvasNode;
  context: VocabRenderContext;
}) {
  const { entries: nodeEntries, footer } = useCanvasPage(node.bind, context);
  const { select, error } = useCanvasSelect(node, context);
  const nodes = nodeEntries
      .map((entry) => coerceGraphNode(entry.value, entry.key, nodeEntries.length, node.bind.allowActions))
    .filter((row): row is GraphNodeRow => row !== null);
  // Edges are not paged with the nodes: an edge the reader cannot see is
  // harmless, and dropping edges by page would draw a graph with lines missing
  // rather than one with fewer nodes. Only edges whose ends are both drawn are
  // painted, which the lookup below already enforces.
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
    <CanvasFrame footer={footer} error={error}>
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
          onClick={() => select(row.id, row.onPress)}
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
    </CanvasFrame>
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

/**
 * What a canvas draws around its engine: the paging sentence under it, and the
 * one line an action left behind when it failed.
 *
 * A wrapper rather than each engine repeating the two, so a `git-dag` and a
 * `graph` cannot end up saying "Showing 100 of 143" in two different places.
 */
function CanvasFrame({
  footer,
  error,
  children,
}: {
  footer: React.ReactNode;
  error: string | null;
  children: React.ReactNode;
}) {
  if (!footer && !error) return <>{children}</>;
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {children}
      {error ? <InlineError message={error} /> : null}
      {footer}
    </div>
  );
}

/**
 * One canvas's page of rows, and the sentence that says so.
 *
 * A canvas reads the same bound collection a `list` does and stopped at the
 * ceiling in the same silence — a reader saw a complete-looking commit graph
 * that was not one. So it pages through exactly the contract the list uses:
 * `vocabListPage` over the host's page count, `Show more` in the host's own
 * words, and the count sentence even on the last page. Keyed on the binding, so
 * a canvas and the list it falls back to are the same list to the host and a
 * reader who paged one does not go back to page one in the other.
 */
function useCanvasPage(
  binding: VocabBinding,
  context: VocabRenderContext,
): { entries: { key?: string; value: unknown }[]; footer: React.ReactNode } {
  const all = canvasEntries(binding, context, VOCAB_LIMITS.maxCanvasItems);
  const pageNode: VocabListNode = { component: "list", bind: binding };
  const page = vocabListPage(all.length, context.listPage(pageNode));
  const label = vocabListPageLabel(page);
  const showMoreListRows = context.showMoreListRows;
  const total = all.length;
  const showMore = React.useCallback(() => {
    showMoreListRows({ component: "list", bind: binding }, total);
  }, [showMoreListRows, binding, total]);
  return {
    entries: all.slice(0, page.drawn),
    footer: label
      ? (
        <VocabListPageRow
          label={label}
          {...(page.hasMore ? { onShowMore: showMore } : {})}
        />
      )
      : null,
  };
}

/**
 * Pressing a canvas row, through the one runner every other control uses.
 *
 * A canvas row used to call `context.dispatch` itself. That skipped
 * `action.confirm` — so the same destructive action asked first behind a button
 * and ran silently behind a commit dot — and it dropped the returned promise,
 * so a refused dispatch surfaced as an unhandled rejection instead of a line
 * under the canvas. `useVocabActionRunner` is the fix for both, and it is the
 * same hook the list rows, the buttons and the bulk bar already press through.
 */
function useCanvasSelect(
  node: VocabCanvasNode,
  context: VocabRenderContext,
): { select: (id: string, rowAction?: VocabAction) => void; error: string | null } {
  const { error, run } = useVocabActionRunner(context);
  const canvasAction = node.onSelect;
  const select = React.useCallback(
    (id: string, rowAction?: VocabAction) => {
      const action = rowAction ?? (canvasAction
        ? { ...canvasAction, args: { ...canvasAction.args, id } }
        : null);
      if (!action) return;
      void run(action);
    },
    [canvasAction, run],
  );
  return { select, error };
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
