import React from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { cn } from "../../ui/cn";
import type { LaneShareGuestSession } from "./laneShareGuestConnection";
import {
  activeLaneShares,
  loadLaneShareReceived,
  retainLaneShareGuestConnection,
  selectLaneShareInWork,
  useLaneShareGuestStore,
  useLaneShareGuestLaneName,
} from "./laneShareGuestStore";
import { laneShareConnectionLabel, laneShareGuestSessionIcon } from "./LaneShareGuestView";

/**
 * The "Shared with me" group of the Work sidebar: lanes other accounts share
 * with this one, kept apart from this project's own lanes (a shared lane of
 * the same repository is still its own row, keyed by grant).
 *
 * Load cost: one read of the received list when the sidebar mounts (cached
 * for 5 minutes, shared with Settings). No connection opens until the user
 * expands one shared lane (its sessions are on the owner's computer) or
 * opens it. With no accepted share, the group does not render at all.
 */

const EMPTY_SESSIONS: LaneShareGuestSession[] = [];

/** The accepted shares, read once for the sidebar. */
export function useLaneShareGuestShelfShares(): LaneShareReceivedEntry[] {
  const received = useLaneShareGuestStore((state) => state.received);
  React.useEffect(() => {
    void loadLaneShareReceived();
  }, []);
  return React.useMemo(() => activeLaneShares(received), [received]);
}

/**
 * One shared lane and its sessions, as a tree: the Work sidebar's group and
 * the Shared with me page both use it. Expanding it opens the connection.
 */
export function LaneShareGuestLaneTree({
  entry,
  selected,
  onSelect = selectLaneShareInWork,
  defaultExpanded = false,
}: {
  entry: LaneShareReceivedEntry;
  selected: { grantId: string; sessionId: string | null } | null;
  onSelect?: (grantId: string, sessionId: string | null) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  React.useEffect(() => { if (defaultExpanded) setExpanded(true); }, [defaultExpanded]);
  React.useEffect(() => (expanded ? retainLaneShareGuestConnection(entry) : undefined), [expanded, entry.grantId, entry.laneId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sessions = useLaneShareGuestStore((state) => state.sessions[entry.grantId] ?? EMPTY_SESSIONS);
  const connectionState = useLaneShareGuestStore((state) => state.connections[entry.grantId]);
  const laneName = useLaneShareGuestLaneName(entry);
  const label = laneShareConnectionLabel(connectionState);
  const laneSelected = selected?.grantId === entry.grantId && selected.sessionId == null;
  const roots = sessions.filter((session) => session.kind !== "subagent");
  const children = (parentId: string) => sessions.filter((session) => session.kind === "subagent" && session.parentSessionId === parentId);
  const orphanSubagents = sessions.filter((session) => session.kind === "subagent" && !sessions.some((parent) => parent.sessionId === session.parentSessionId));

  const sessionRow = (session: LaneShareGuestSession, depth: number) => (
    <button
      key={session.sessionId}
      type="button"
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[11.5px] text-fg/75 hover:bg-fg/[0.05]",
        selected?.grantId === entry.grantId && selected.sessionId === session.sessionId && "bg-fg/[0.07] text-fg",
      )}
      style={{ paddingLeft: 22 + depth * 12 }}
      onClick={() => onSelect(entry.grantId, session.sessionId)}
    >
      <span className="shrink-0 text-fg/45">{laneShareGuestSessionIcon(session.kind, 12)}</span>
      <span className="min-w-0 flex-1 truncate" title={session.title}>{session.title}</span>
    </button>
  );

  return (
    <div className="flex min-w-0 flex-col" data-testid="lane-share-shelf-lane">
      <div className={cn("flex min-w-0 items-center gap-1 rounded-md pr-1 hover:bg-fg/[0.04]", laneSelected && "bg-fg/[0.07]")}>
        <button
          type="button"
          className="shrink-0 p-1 text-fg/45"
          aria-label={expanded ? "Hide sessions" : "Show sessions"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col py-1 text-left"
          onClick={() => onSelect(entry.grantId, null)}
        >
          <span className="min-w-0 truncate text-[12px] text-fg/85" title={laneName ?? undefined}>{laneName ?? "Shared lane"}</span>
          <span className="min-w-0 truncate text-[10.5px] text-fg/45" title={entry.giverLabel ?? undefined}>
            {connectionState && connectionState.kind !== "connected" ? label.text : `From ${entry.giverLabel ?? "another account"}`}
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="flex min-w-0 flex-col">
          {connectionState?.kind === "connected" && sessions.length === 0 ? (
            <span className="py-1 pl-[22px] text-[11px] text-fg/45">Nothing to see yet</span>
          ) : null}
          {connectionState && connectionState.kind !== "connected" ? (
            <span className="truncate py-1 pl-[22px] text-[11px] text-fg/45">{label.text}</span>
          ) : null}
          {roots.map((session) => (
            <React.Fragment key={session.sessionId}>
              {sessionRow(session, 0)}
              {children(session.sessionId).map((child) => sessionRow(child, 1))}
            </React.Fragment>
          ))}
          {orphanSubagents.map((session) => sessionRow(session, 0))}
        </div>
      ) : null}
    </div>
  );
}

/** The rows of the group. The header is the sidebar's own shelf header. */
export function LaneShareGuestShelfRows({ shares }: { shares: readonly LaneShareReceivedEntry[] }) {
  const selected = useLaneShareGuestStore((state) => state.workSelection);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-1" data-testid="shelf-body-shared-with-me">
      {shares.map((entry) => <LaneShareGuestLaneTree key={entry.grantId} entry={entry} selected={selected} />)}
    </div>
  );
}
