import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";
import { FolderSimple } from "@phosphor-icons/react";
import type { RecentProjectGroup } from "../app/projectTabGrouping";
import type { AppState } from "../../state/appStore";
import type { useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import { FitList } from "../home/HomeFitList";
import { WelcomeCardHead } from "./ProjectWelcomeSidePanels";
import { RecentProjectRow, type WebRowChrome } from "./ProjectWelcomeWebRows";
import type { RecentProjectSummary, RemoteRuntimeConnectionState } from "../../../shared/types";

type WebMachine = ReturnType<typeof useWebMachines>[number];

export type ProjectsCardRow = { group: RecentProjectGroup; rp: RecentProjectSummary; key: string };

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
  onOpen: (rp: RecentProjectSummary) => void;
  onTogglePin: (group: RecentProjectGroup) => Promise<void> | void;
  onForget: (group: RecentProjectGroup) => void;
  onMerge: (rp: RecentProjectSummary) => void;
  onRowMenu: (menu: { x: number; y: number; key: string }) => void;
};

/** One recent project, with its live connection, open and busy state. */
function ProjectsCardRowView({ row, ctx }: { row: ProjectsCardRow; ctx: RowContext }) {
  const { group, rp, key } = row;
  const isRemote = rp.kind === "remote" && Boolean(rp.remote);
  const targetId = rp.remote?.targetId;
  const baseState = isRemote && targetId ? (ctx.connectionByTarget.get(targetId) ?? "idle") : null;
  const connectionState: RemoteRuntimeConnectionState | null = ctx.connectingKeys.has(key) ? "connecting" : baseState;
  const isOpenLocal = !isRemote && ctx.openRootPath === rp.rootPath;
  const binding = ctx.projectBinding;
  const isOpenRemote =
    isRemote
    && binding?.kind === "remote"
    && binding.targetId === rp.remote?.targetId
    && binding.projectId === rp.remote?.projectId;
  const canMerge = !isRemote && Boolean(rp.worktreeOf) && rp.exists;
  const machine = ctx.webMode && targetId ? ctx.webMachineByKey.get(targetId) ?? null : null;
  // The connect/open stages belong to the row that was clicked. Every other
  // row on the same machine sees the same machine-level "connecting", so it
  // has to be suppressed there explicitly — otherwise one click spins the
  // whole list.
  const isOpeningRow = ctx.openingRowKey === key;
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
      isOpen={isOpenLocal || isOpenRemote}
      isForgetting={ctx.pendingForgetKeys.has(group.id)}
      busy={ctx.openingRowKey != null && !isOpeningRow}
      onOpen={() => ctx.onOpen(rp)}
      onTogglePin={() => void ctx.onTogglePin(group)}
      onForget={() => ctx.onForget(group)}
      onMerge={canMerge ? () => ctx.onMerge(rp) : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        ctx.onRowMenu({ x: event.clientX, y: event.clientY, key });
      }}
      primary={group.primary}
      locations={group.locations}
      onSelectMachine={(location) => ctx.onOpen(location.summary)}
      lastActiveAt={group.lastOpenedAt}
      web={web}
    />
  );
}

/**
 * The home page's Projects widget: recent projects that fit, the rest behind
 * "more". A gallery preview (`preview`) shows the same rows without the
 * dialog and without taking the page list's ref.
 */
export function ProjectsCard({
  preview,
  rows,
  count,
  listRef,
  onListKeyDown,
  ...ctx
}: RowContext & {
  preview: boolean;
  rows: readonly ProjectsCardRow[];
  count: number;
  listRef: MutableRefObject<HTMLDivElement | null>;
  onListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const hasProjects = count > 0;
  const renderRows = () => rows.map((row) => <ProjectsCardRowView key={row.group.id} row={row} ctx={ctx} />);
  return (
    <section className="kit-card ade-home-card ade-home-projects" aria-label="Recent projects">
      <WelcomeCardHead icon={FolderSimple} title="Projects" count={hasProjects ? count : null} />
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
            ? "Projects you open on your machines show up here."
            : "Add a folder or clone a repository to get started. You can also drop a folder anywhere on this page."}
        </div>
      )}
    </section>
  );
}
