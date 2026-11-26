import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { CaretRight, Coffee, Notebook, X } from "@phosphor-icons/react";
import type {
  CtoAvatarLook,
  CtoAvatarState,
  CtoUpdateOpenWorkArgs,
  LaneSummary,
  OpenProjectBinding,
  TerminalToolType,
} from "../../../shared/types";
import { ToolLogo } from "../terminals/ToolLogos";
import { CtoAvatar } from "./avatar/CtoAvatar";
import { CtoOpenWorkList } from "./CtoOpenWorkList";
import { CtoRoutineRows } from "./CtoRoutineRows";
import { useCtoMemory } from "./useCtoMemory";
import { CtoLibrary } from "./CtoLibrary";
import type { CtoActivityData, CtoChildChat } from "./useCtoActivityData";
import { openCtoChat } from "./ctoNavigation";
import { CtoEmptyLine } from "./ctoSettingsUi";
import { laneDisplayName } from "../../../shared/laneDisplayName";

export type CtoPanelTab = "activity" | "library";

/** Children shown under "Now" before the rest fold into a count. */
const NOW_CHILD_CAP = 6;

/** The notes in the CTO's memory file; headings, rules and code fences are structure, not notes. */
function noteLines(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|```|---|\*\*\*)/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * The line under a child chat's title: its own live status line ("Waiting for
 * CI on 57628e0"), else its lane when that says something the title does not.
 */
function childDetail(child: CtoChildChat, title: string, laneName: string | null): string | null {
  const status = child.summary.statusNote?.trim();
  if (status && status.toLowerCase() !== title.toLowerCase()) return status;
  if (laneName && laneName.trim().toLowerCase() !== title.toLowerCase()) return laneName;
  return null;
}

function childStatusWord(child: CtoChildChat): string {
  if (child.summary.awaitingInput) return "Needs you";
  if (child.running) return "Working";
  return "Idle";
}

/**
 * The CTO's profile panel: its big avatar, name and status, then Activity
 * (what it is doing now, what it has scheduled, its open work, what it
 * remembers) and Library (what its work produced).
 *
 * Everything reads from and writes to `pin`, the CTO's home machine.
 */
export function CtoSidePanel({
  look,
  name,
  statusPhrase,
  avatarState,
  ctoSessionId,
  pin,
  pinTargetsTab,
  lanes,
  primaryLaneId,
  turnActive,
  liveStep,
  turnsFinished,
  data,
  tab,
  onTabChange,
  onOpenSettings,
  onClose,
  sheet = false,
}: {
  look: CtoAvatarLook;
  name: string;
  statusPhrase: string;
  avatarState: CtoAvatarState;
  ctoSessionId: string | null;
  pin: OpenProjectBinding | null;
  pinTargetsTab: boolean;
  lanes: LaneSummary[];
  primaryLaneId: string | null;
  turnActive: boolean;
  liveStep: string | null;
  /** Bumps when a CTO turn ends: notes and open work may have changed. */
  turnsFinished: number;
  /** The CTO's child chats and what they produced (`useCtoActivityData`, owned by the page). */
  data: CtoActivityData;
  tab: CtoPanelTab;
  onTabChange: (tab: CtoPanelTab) => void;
  onOpenSettings: (section?: "memory" | "routines") => void;
  onClose: () => void;
  /** Drawn inside the narrow-window sheet rather than docked. */
  sheet?: boolean;
}) {
  const navigate = useNavigate();
  const memory = useCtoMemory(pin);
  const refreshMemory = memory.refresh;

  // The CTO's own turns are what change its notes and open work.
  useEffect(() => {
    if (turnsFinished > 0) void refreshMemory();
  }, [refreshMemory, turnsFinished]);

  // A child chat that comes to rest may close the open work linked to it; the
  // read closes it on the host. Keyed on which children rest, and read only
  // when one more does, not per render or when one starts again.
  const restingChildKey = useMemo(
    () => data.children
      .filter((child) => !child.running && child.summary.awaitingInput !== true)
      .map((child) => child.summary.sessionId)
      .sort()
      .join(","),
    [data.children],
  );
  const restingChildrenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const previous = restingChildrenRef.current;
    const resting = new Set(restingChildKey ? restingChildKey.split(",") : []);
    restingChildrenRef.current = resting;
    if (previous && [...resting].some((id) => !previous.has(id))) void refreshMemory();
  }, [refreshMemory, restingChildKey]);

  // "Now" is what is happening: chats still working or waiting on the person.
  // A helper that finished its turn is history (its lane and PR are in Library).
  const openChildren = useMemo(
    () => data.children.filter((child) =>
      !child.summary.endedAt
      && child.summary.status !== "ended"
      && (child.running || child.summary.awaitingInput === true)),
    [data.children],
  );

  const lanesById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);
  const notes = useMemo(() => noteLines(memory.memory?.memory), [memory.memory?.memory]);
  const openWork = memory.memory?.openWork ?? [];
  const updateOpenWork = memory.updateOpenWork;
  const handleOpenWorkChange = useCallback(
    async (args: CtoUpdateOpenWorkArgs) => { await updateOpenWork(args); },
    [updateOpenWork],
  );

  const shownChildren = openChildren.slice(0, NOW_CHILD_CAP);
  const hiddenChildren = openChildren.length - shownChildren.length;

  return (
    <aside
      className="ade-cto-panel"
      data-sheet={sheet ? "true" : undefined}
      aria-label={`${name} profile`}
      data-testid="cto-side-panel"
      style={{ "--cto-accent": look.color } as React.CSSProperties}
    >
      {sheet ? (
        <button type="button" className="ade-cto-panel-close kit-icon-btn" aria-label="Close panel" title="Close panel" onClick={onClose}>
          <X size={13} />
        </button>
      ) : null}

      <header className="ade-cto-profile">
        <div className="ade-cto-profile-halo" aria-hidden />
        <CtoAvatar look={look} state={avatarState} size={96} motion="live" title={`${name}, ${statusPhrase.toLowerCase()}`} />
        <h2 className="ade-cto-profile-name" title={name}>{name}</h2>
        <p className="ade-cto-profile-status" title={statusPhrase}>{statusPhrase}</p>
        <div className="kit-seg ade-cto-tabs" data-case="sentence" role="tablist" aria-label="Panel">
          <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => onTabChange("activity")}>Activity</button>
          <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => onTabChange("library")}>Library</button>
        </div>
      </header>

      <div className="ade-cto-panel-body">
        {tab === "activity" ? (
          <>
            <section className="ade-cto-section" aria-label="Now">
              <h3 className="ade-cto-section-title">Now</h3>
              {turnActive ? (
                <div className="ade-cto-now-line">
                  <CtoAvatar look={look} state="working" size={16} motion="static" />
                  <span title={liveStep ?? undefined}>{liveStep ?? "Working"}</span>
                </div>
              ) : null}
              {shownChildren.length > 0 ? (
                <ul className="ade-cto-list">
                  {shownChildren.map((child) => {
                    const lane = lanesById.get(child.summary.laneId);
                    const childTitle = child.summary.title?.trim() || "Untitled chat";
                    const detail = childDetail(child, childTitle, lane ? laneDisplayName(lane) : null);
                    return (
                      <li key={child.summary.sessionId}>
                        <button
                          type="button"
                          className="ade-cto-row"
                          title={detail ? `${childTitle}\n${detail}` : childTitle}
                          onClick={() => openCtoChat(navigate, child.summary.sessionId, child.summary.laneId, pin, pinTargetsTab)}
                        >
                          <span className="ade-cto-row-icon">
                            <ToolLogo toolType={child.summary.provider as TerminalToolType} size={14} />
                          </span>
                          <span className="ade-cto-row-body">
                            <span className="ade-cto-row-title">{childTitle}</span>
                            {detail ? <span className="ade-cto-row-detail">{detail}</span> : null}
                          </span>
                          <span className="ade-cto-row-meta" data-state={child.summary.awaitingInput ? "warn" : child.running ? "live" : undefined}>
                            {childStatusWord(child)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {hiddenChildren > 0 ? <p className="ade-cto-more">+{hiddenChildren} more</p> : null}
              {!turnActive && shownChildren.length === 0 ? (
                <CtoEmptyLine icon={<Coffee size={14} />}>Nothing running</CtoEmptyLine>
              ) : null}
            </section>

            <section className="ade-cto-section" aria-label="Upcoming">
              <h3 className="ade-cto-section-title">Upcoming</h3>
              <CtoRoutineRows sessionId={ctoSessionId} pin={pin} variant="panel" />
            </section>

            <section className="ade-cto-section" aria-label="Open work">
              <h3 className="ade-cto-section-title">Open work</h3>
              <CtoOpenWorkList items={openWork} onChange={handleOpenWorkChange} compact />
            </section>

            <section className="ade-cto-section" aria-label="Remembers">
              <div className="ade-cto-section-head">
                <h3 className="ade-cto-section-title">
                  Remembers
                  {notes.length > 0 ? <span className="ade-cto-section-count">{notes.length}</span> : null}
                </h3>
                <button type="button" className="ade-cto-link" onClick={() => onOpenSettings("memory")}>
                  See all <CaretRight size={9} weight="bold" aria-hidden />
                </button>
              </div>
              {notes.length > 0 ? (
                <ul className="ade-cto-notes">
                  {notes.slice(0, 3).map((note, index) => <li key={`${index}:${note}`} title={note}>{note}</li>)}
                </ul>
              ) : (
                <CtoEmptyLine icon={<Notebook size={14} />} hint={memory.loading ? undefined : `Tell ${name} something worth keeping`}>
                  {memory.loading ? "Loading…" : "No notes yet"}
                </CtoEmptyLine>
              )}
            </section>
          </>
        ) : (
          <CtoLibrary
            childChats={data.children}
            prs={data.prs}
            proof={data.proof}
            loaded={data.libraryLoaded}
            lanes={lanes}
            primaryLaneId={primaryLaneId}
            pin={pin}
            pinTargetsTab={pinTargetsTab}
          />
        )}
      </div>
    </aside>
  );
}
