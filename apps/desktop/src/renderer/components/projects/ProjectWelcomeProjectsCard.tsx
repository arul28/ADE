import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";
import { FolderSimple } from "@phosphor-icons/react";
import type { RecentProjectGroup } from "../app/projectTabGrouping";
import { ACCOUNT_MACHINE_TARGET_PREFIX, recentProjectLocationKey } from "../app/projectTabGrouping";
import type { AppState } from "../../state/appStore";
import type { useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import { FitList } from "../home/HomeFitList";
import { LaneShareHomeFoot } from "../laneShare/guest/LaneShareHomeFoot";
import { WelcomeCardHead } from "./ProjectWelcomeSidePanels";
import { RecentProjectRow, type WebRowChrome } from "./ProjectWelcomeWebRows";
import type { HomeLocalGroup, HomeProjectRow } from "./homeProjectRows";
import type { RecentProjectSummary, RemoteRuntimeConnectionState } from "../../../shared/types";

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

/** One project, with its live connection, open and busy state. */
function ProjectsCardRowView({ row, ctx }: { row: HomeProjectRow; ctx: RowContext }) {
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
      onForget={() => ctx.onRemove(row)}
      removeLabel={row.kind === "account" ? `Remove ${group.displayName}…` : `Remove ${rp.displayName} from this list`}
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

/**
 * The home page's Projects widget: the account's projects that fit, then this
 * computer's other folders ("Only on <computer>"), the rest behind "more". A
 * gallery preview (`preview`) shows the same rows without the dialog and
 * without taking the page list's ref.
 */
export function ProjectsCard({
  preview,
  rows,
  localGroups,
  count,
  listRef,
  onListKeyDown,
  ...ctx
}: RowContext & {
  preview: boolean;
  /** The account's projects. */
  rows: readonly HomeProjectRow[];
  /** Folders that are no account project, one group per computer. */
  localGroups: readonly HomeLocalGroup[];
  /** The header count: account projects only (local folders when there is no account list). */
  count: number;
  listRef: MutableRefObject<HTMLDivElement | null>;
  onListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const hasProjects = rows.length > 0 || localGroups.some((group) => group.rows.length > 0);
  const renderRows = () => (
    <>
      {rows.map((row) => <ProjectsCardRowView key={row.key} row={row} ctx={ctx} />)}
      {localGroups.map((group) => (
        <Fragment key={group.key}>
          {group.label ? (
            <div className="kit-eyebrow ade-home-pr-divider ade-welcome-local-head" data-fit-head title={group.label}>
              {group.label}
            </div>
          ) : null}
          {group.rows.map((row) => <ProjectsCardRowView key={row.key} row={row} ctx={ctx} />)}
        </Fragment>
      ))}
    </>
  );
  return (
    <section className="kit-card ade-home-card ade-home-projects" aria-label="Projects">
      <WelcomeCardHead icon={FolderSimple} title="Projects" count={count > 0 ? count : null} />
      {hasProjects ? (
        <div
          id="ade-welcome-project-list"
          ref={preview ? undefined : listRef}
          className="kit-card-body ade-welcome-list"
          data-flush="true"
          onKeyDown={onListKeyDown}
        >
          <FitList more={preview ? null : { dialog: { title: "Projects", render: renderRows } }}>
            {renderRows()}
          </FitList>
        </div>
      ) : (
        <div className="ade-welcome-empty">
          <strong>No projects yet</strong>
          {ctx.webMode
            ? "Projects you add on your computers show up here."
            : "Add a folder or clone a repository to get started. You can also drop a folder anywhere on this page."}
        </div>
      )}
      {preview ? null : <LaneShareHomeFoot />}
    </section>
  );
}
