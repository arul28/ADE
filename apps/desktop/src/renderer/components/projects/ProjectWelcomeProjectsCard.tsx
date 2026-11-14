import { useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { FolderSimple } from "@phosphor-icons/react";
import type { RecentProjectGroup } from "../app/projectTabGrouping";
import { ACCOUNT_MACHINE_TARGET_PREFIX, recentProjectLocationKey } from "../app/projectTabGrouping";
import type { AppState } from "../../state/appStore";
import type { useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import { FitList } from "../home/HomeFitList";
import { LaneShareHomeRows } from "../laneShare/guest/LaneShareHomeRows";
import { WelcomeCardHead } from "./ProjectWelcomeSidePanels";
import { RecentProjectRow, type WebRowChrome } from "./ProjectWelcomeWebRows";
import type { HomeLocalGroup, HomeProjectRow } from "./homeProjectRows";
import { requestCopiesMenu } from "./removeProjectRequest";
import type { RecentProjectSummary, RemoteRuntimeConnectionState } from "../../../shared/types";
import type { LaneShareReceivedEntry } from "../../../shared/types/laneShare";

type WebMachine = ReturnType<typeof useWebMachines>[number];

type RowContext = {
  connectionByTarget: Map<string, RemoteRuntimeConnectionState>;
  connectingKeys: Set<string>;
  pendingForgetKeys: Set<string>;
  /** The row whose open is in flight; every other row waits. */
  openingRowKey: string | null;
  /** The open local project's root, to mark its row open. */
  openRootPath: string | null;
  projectBinding: AppState["projectBinding"];
  webMode: boolean;
  webMachineByKey: Map<string, WebMachine>;
  /** Web: machines by account machine key (an account row names its computer that way). */
  webMachineByAccountKey: Map<string, WebMachine>;
  onOpen: (rp: RecentProjectSummary) => void;
  onTogglePin: (group: RecentProjectGroup) => Promise<void> | void;
  /** The row's X: the remove window for an account project, forget with Undo for a local folder. */
  onRemove: (row: HomeProjectRow) => void;
  /** A row hidden from this list: list it again. */
  onShowAgain: (row: HomeProjectRow) => void;
  onMerge: (rp: RecentProjectSummary) => void;
  onRowMenu: (menu: { x: number; y: number; key: string }) => void;
};

function webMachineFor(ctx: RowContext, targetId: string | undefined): WebMachine | null {
  if (!ctx.webMode || !targetId) return null;
  if (targetId.startsWith(ACCOUNT_MACHINE_TARGET_PREFIX)) {
    return ctx.webMachineByAccountKey.get(targetId.slice(ACCOUNT_MACHINE_TARGET_PREFIX.length)) ?? null;
  }
  return ctx.webMachineByKey.get(targetId) ?? null;
}

/**
 * One project, with its live connection, open and busy state. In the full
 * Projects dialog, `closeDialog` shuts it: the copies menu belongs to the top
 * bar, which a modal dialog covers, so a chip there closes the dialog first.
 */
function ProjectsCardRowView({ row, ctx, closeDialog, namedByGroup = false, hiddenOnList = false }: {
  row: HomeProjectRow;
  ctx: RowContext;
  closeDialog?: () => void;
  /** Under an "Only on <computer>" heading. */
  namedByGroup?: boolean;
  /** Hidden from this list and shown on request: its button lists it again. */
  hiddenOnList?: boolean;
}) {
  const { group, rp, key } = row;
  // The page keys an open in flight by the location it opens.
  const openKey = recentProjectLocationKey(rp);
  const isRemote = rp.kind === "remote" && Boolean(rp.remote);
  const targetId = rp.remote?.targetId;
  const baseState = isRemote && targetId ? (ctx.connectionByTarget.get(targetId) ?? "idle") : null;
  const connectionState: RemoteRuntimeConnectionState | null = ctx.connectingKeys.has(openKey) ? "connecting" : baseState;
  const binding = ctx.projectBinding;
  // Open when the copy in front is any of the row's copies.
  const isOpen = group.locations.some((location) => {
    const summary = location.summary;
    if (summary.kind !== "remote" || !summary.remote) return ctx.openRootPath != null && ctx.openRootPath === summary.rootPath;
    return binding?.kind === "remote"
      && binding.targetId === summary.remote.targetId
      && binding.projectId === summary.remote.projectId;
  });
  const canMerge = !isRemote && Boolean(rp.worktreeOf) && rp.exists;
  const machine = webMachineFor(ctx, targetId);
  // The connect/open stages belong to the row that was clicked. Every other
  // row on the same machine sees the same machine-level "connecting", so it
  // has to be suppressed there explicitly — otherwise one click spins the
  // whole list.
  const isOpeningRow = ctx.openingRowKey === openKey;
  const web: WebRowChrome | null = machine
    ? {
        status: isOpeningRow
          ? "connecting"
          : machine.status === "connecting"
            ? "available"
            : machine.status,
        connectStage: isOpeningRow ? machine.connectStage ?? "Dialing relay…" : null,
        stale: machine.stale,
      }
    : null;
  return (
    <RecentProjectRow
      rp={rp}
      connectionState={connectionState}
      isOpen={isOpen}
      isForgetting={ctx.pendingForgetKeys.has(group.id)}
      busy={ctx.openingRowKey != null && !isOpeningRow}
      onOpen={() => ctx.onOpen(rp)}
      onTogglePin={group.recentKeys.length > 0 ? () => void ctx.onTogglePin(group) : undefined}
      onForget={() => (hiddenOnList ? ctx.onShowAgain(row) : ctx.onRemove(row))}
      restores={hiddenOnList}
      removeLabel={hiddenOnList
        ? `Show ${group.displayName} on this list`
        : row.kind === "account" ? `Remove ${group.displayName}…` : `Remove ${rp.displayName} from this list`}
      onMerge={canMerge ? () => ctx.onMerge(rp) : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        ctx.onRowMenu({ x: event.clientX, y: event.clientY, key });
      }}
      primary={group.primary}
      locations={group.locations}
      repository={row.repository}
      computers={row.computers}
      iconDataUrl={row.iconDataUrl}
      local={row.kind === "local"}
      namedByGroup={namedByGroup}
      onShowCopies={row.kind === "account"
        ? (anchor) => {
            closeDialog?.();
            requestCopiesMenu({ ...anchor, projectId: row.key });
          }
        : undefined}
      onSelectMachine={(location) => {
        // The copy on the machine picked here opens, and the tab stays on it
        // (F6): a row of another machine never opens as this computer's folder.
        ctx.onOpen(location.summary);
      }}
      lastActiveAt={group.lastOpenedAt}
      web={web}
    />
  );
}

type RowItem = { key: string; row: boolean; node: ReactNode };

/**
 * Rows the card renders inline. A card is never taller than this many rows,
 * and every rendered row costs style and layout on each pass over Home (the
 * add window's open is three such passes), so the rest live only in the
 * "N more" dialog.
 */
const INLINE_ROW_CAP = 40;

/** The first `cap` rows with their headings, and how many rows were left out. */
function capRowItems(items: readonly RowItem[], cap: number): { items: RowItem[]; unrendered: number } {
  const kept: RowItem[] = [];
  let rowsKept = 0;
  let unrendered = 0;
  for (const item of items) {
    if (item.row && rowsKept >= cap) {
      unrendered += 1;
      continue;
    }
    if (rowsKept >= cap) continue;
    kept.push(item);
    if (item.row) rowsKept += 1;
  }
  // A heading with no row after it goes too.
  while (kept.length > 0 && !kept[kept.length - 1]!.row) kept.pop();
  return { items: kept, unrendered };
}

/**
 * The home page's Projects widget: the account's projects that fit, then this
 * computer's other folders ("Only on <computer>"), the rest behind "more". A
 * gallery preview (`preview`) shows the same rows without the dialog and
 * without taking the page list's ref.
 */
export function ProjectsCard({
  preview,
  rows,
  hiddenRows,
  localGroups,
  count,
  listRef,
  onListKeyDown,
  sharedRows,
  ...ctx
}: RowContext & {
  preview: boolean;
  /** The account's projects. */
  rows: readonly HomeProjectRow[];
  /** Account projects hidden from this list; they count, and show on request. */
  hiddenRows: readonly HomeProjectRow[];
  /** Folders that are no account project, one group per computer. */
  localGroups: readonly HomeLocalGroup[];
  /** The header count: account projects only (local folders when there is no account list). */
  count: number;
  /** Lanes shared with this account and open invites (`useLaneShareHomeRows`). */
  sharedRows: readonly LaneShareReceivedEntry[];
  listRef: MutableRefObject<HTMLDivElement | null>;
  onListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const revealHidden = showHidden && hiddenRows.length > 0;
  const hasProjects = rows.length > 0 || revealHidden || localGroups.some((group) => group.rows.length > 0);
  const renderItems = (closeDialog?: () => void): RowItem[] => {
    const items: RowItem[] = [];
    const head = (key: string, label: string) => items.push({
      key,
      row: false,
      node: (
        <div key={key} className="kit-eyebrow ade-home-pr-divider ade-welcome-local-head" data-fit-head title={label}>
          {label}
        </div>
      ),
    });
    const rowItem = (row: HomeProjectRow, extra?: { namedByGroup?: boolean; hiddenOnList?: boolean }) => items.push({
      key: row.key,
      row: true,
      node: <ProjectsCardRowView key={row.key} row={row} ctx={ctx} closeDialog={closeDialog} {...extra} />,
    });
    // Hidden rows first, so the press on "N hidden" shows its result where the person looks.
    if (revealHidden) {
      head("hidden-head", "Hidden from this list");
      for (const row of hiddenRows) rowItem(row, { hiddenOnList: true });
      if (rows.length > 0) head("listed-head", "Listed");
    }
    for (const row of rows) rowItem(row);
    for (const group of localGroups) {
      if (group.label) head(group.key, group.label);
      for (const row of group.rows) rowItem(row, { namedByGroup: Boolean(group.label) });
    }
    return items;
  };
  // The card shows what fits, at most INLINE_ROW_CAP rows; the dialog shows every row.
  const inlineItems = capRowItems(renderItems(), INLINE_ROW_CAP);
  return (
    <section className="kit-card ade-home-card ade-home-projects" aria-label="Projects">
      <WelcomeCardHead icon={FolderSimple} title="Projects" count={count > 0 ? count : null}>
        {/* "From this list" hides a project on this computer only; the
            account still has it, so it still counts. This shows them again. */}
        {hiddenRows.length > 0 && !preview ? (
          <button
            type="button"
            className="ade-welcome-hidden-toggle"
            aria-pressed={revealHidden}
            title={revealHidden ? "Stop showing the hidden projects" : "Show the projects hidden from this list"}
            onClick={() => setShowHidden((value) => !value)}
          >
            {hiddenRows.length} hidden
          </button>
        ) : null}
      </WelcomeCardHead>
      {hasProjects ? (
        <div
          id="ade-welcome-project-list"
          ref={preview ? undefined : listRef}
          className="kit-card-body ade-welcome-list"
          data-flush="true"
          onKeyDown={onListKeyDown}
        >
          <FitList
            more={preview ? null : { dialog: { title: "Projects", render: (close) => renderItems(close).map((item) => item.node) } }}
            unrendered={preview ? 0 : inlineItems.unrendered}
          >
            {inlineItems.items.map((item) => item.node)}
          </FitList>
        </div>
      ) : hiddenRows.length > 0 ? (
        // Every project is hidden from this list: they still count, so say where they went.
        <div className="ade-welcome-empty">
          <strong>Every project is hidden from this list</strong>
          They stay on your account and on your computers.
          {preview ? null : (
            <button type="button" className="ade-welcome-hidden-toggle" onClick={() => setShowHidden(true)}>
              Show hidden projects
            </button>
          )}
        </div>
      ) : sharedRows.length > 0 && !preview ? null : (
        <div className="ade-welcome-empty">
          <strong>No projects yet</strong>
          {ctx.webMode
            ? "Projects you add on your computers show up here."
            : "Add a folder or clone a repository to get started. You can also drop a folder anywhere on this page."}
        </div>
      )}
      {preview ? null : <LaneShareHomeRows rows={sharedRows} />}
    </section>
  );
}
