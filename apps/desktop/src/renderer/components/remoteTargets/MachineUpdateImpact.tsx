import "./machines.css";
import type { ReactNode } from "react";
import { ArrowClockwise, ArrowRight, ChatCircleDots, DeviceMobile } from "@phosphor-icons/react";
import type { UpdateImpact } from "../../../shared/types";
import { updateTrackLabel, updateTrackOfVersion, type UpdateTrack } from "../../../shared/updateTrack";
import { UpdateTrackChip } from "../app/ChannelBadge";
import { confirmDialog } from "../ui/dialog/confirm";
import {
  MachineAvatar,
  machineFormFactor,
  machinePlatform,
  type MachinePlatform,
} from "./MachineIdentity";
import { machineUpdateTrack, type ConnectedMachine, type MachineUpdateTarget } from "./remoteMachineModel";

/**
 * What an update does on each machine, as one row per machine: its tile and
 * name, the version it goes from and to, its track, what is running there and
 * whether that continues. Shared by this computer's install dialog and
 * "Update & restart" on other machines, so both read the same way.
 */

/** A machine, and what an update would stop on it. */
export type MachineWithImpact = ConnectedMachine & { impact: UpdateImpact };

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One line for what a restart stops: chats are running, CLI sessions and
 * terminals are open (a quiet one closes too). "2 agent chats running, 1
 * terminal open".
 */
export function updateImpactHeadline(impact: UpdateImpact): string {
  if (!impact.checked) return "Couldn't check what's running";
  const chats = impact.chats.length;
  const openParts: string[] = [];
  if (impact.cliSessions > 0) openParts.push(counted(impact.cliSessions, "CLI session", "CLI sessions"));
  if (impact.terminals > 0) openParts.push(counted(impact.terminals, "terminal", "terminals"));
  const running = chats > 0 ? counted(chats, "agent chat", "agent chats") : null;
  const open = openParts.length > 0 ? openParts.join(" and ") : null;
  if (!running && !open) return impact.busyWithoutDetail ? "Work is running" : "Nothing is running";
  const line = running && open
    ? `${running} running, ${open} open`
    : running
      ? `${running} ${chats === 1 ? "is" : "are"} running`
      : `${open} ${impact.cliSessions + impact.terminals === 1 ? "is" : "are"} open`;
  return impact.busyWithoutDetail ? `${line}; more work is running` : line;
}

/** The quiet line for what a restart ends for good, or for what can't be known. */
function impactNote(impact: UpdateImpact): string | null {
  if (!impact.checked) return "Anything running there stops when ADE restarts.";
  if (impact.busyWithoutDetail) return "That ADE is too old to list everything running.";
  if (impact.cliSessions + impact.terminals > 0) return "CLI sessions and terminals close and don't reopen.";
  return null;
}

/** Chats that continue by themselves after a restart: all but the ones ADE can't queue. */
export function resumableChatCount(impact: UpdateImpact): number {
  return impact.chats.filter((chat) => chat.resumable !== false).length;
}

/** "Continues on its own after the update", in the same words for every machine. */
export function continuesAfterUpdateLabel(count: number): string {
  return count === 1 ? "Continues on its own after the update" : "Continue on their own after the update";
}

/**
 * Restart recovery on that machine resumes a cut-off turn by itself unless the
 * chat was waiting on an answer, the machine's setting is off, or it already
 * resumed three times in a row. That machine's setting is not readable here,
 * so the exceptions are named rather than promised away.
 */
const REMOTE_CONTINUE_CAVEAT =
  "Unless a chat is waiting for your answer, or Continue chats after restarts is off on that machine.";

const MAX_LISTED_CHATS = 4;

/** One row's facts, for this computer or another machine. */
export type MachineUpdateRowModel = {
  key: string;
  name: string;
  colorKey: string;
  platform: MachinePlatform;
  fromVersion: string | null;
  toVersion: string | null;
  fromTrack: UpdateTrack;
  toTrack: UpdateTrack;
  thisComputer: boolean;
  impact: UpdateImpact;
};

/** A row for another machine; it always stays on its own track. */
export function remoteMachineRowModel(machine: MachineWithImpact & Pick<MachineUpdateTarget, "targetVersion">): MachineUpdateRowModel {
  const track = machineUpdateTrack(machine);
  return {
    key: machine.id,
    name: machine.name,
    colorKey: machine.colorKey ?? machine.id,
    platform: machinePlatform(machine.arch),
    fromVersion: machine.versionLabel ?? machine.version,
    toVersion: machine.targetVersion,
    fromTrack: track,
    toTrack: track,
    thisComputer: false,
    impact: machine.impact,
  };
}

/** What happens to the track, in words, when tracks are in play. */
function outcomeText(row: MachineUpdateRowModel): string {
  if (row.fromTrack !== row.toTrack) return `switches to ${updateTrackLabel(row.toTrack)}`;
  return `stays on ${updateTrackLabel(row.toTrack)}`;
}

export function MachineUpdateRow({
  row,
  showTracks,
  control,
  continueControl,
  extra,
}: {
  row: MachineUpdateRowModel;
  /** Name each machine's track; on whenever a Beta machine or a switch is in the list. */
  showTracks: boolean;
  /** Right-aligned control on the name line (another machine's "Update"). */
  control?: ReactNode;
  /** This computer's "continue" choice; other machines get the plain line. */
  continueControl?: ReactNode;
  /** More lines under the row (connected phones). */
  extra?: ReactNode;
}) {
  const { impact } = row;
  const projectNames = new Set(impact.chats.map((chat) => chat.projectName).filter(Boolean));
  const showProject = projectNames.size > 1;
  const listed = impact.chats.slice(0, MAX_LISTED_CHATS);
  const unlisted = impact.chats.length - listed.length;
  const resumable = resumableChatCount(impact);
  const note = impactNote(impact);
  const busy = impact.chats.length > 0 || impact.cliSessions + impact.terminals > 0 || impact.busyWithoutDetail || !impact.checked;
  return (
    <div className="ade-upd-row" data-testid={`update-row-${row.thisComputer ? "this-computer" : row.key}`}>
      <MachineAvatar
        colorKey={row.colorKey}
        name={row.name}
        platform={row.platform}
        formFactor={machineFormFactor({ name: row.name })}
        size={34}
      />
      <div className="ade-upd-main">
        <div className="ade-upd-head">
          <span className="ade-upd-name">{row.name}</span>
          {/* The track it is on now, as the title bar shows it; the line below says what changes. */}
          {showTracks ? <UpdateTrackChip track={row.fromTrack} /> : null}
          {control ? <span className="ade-upd-control">{control}</span> : null}
        </div>
        <div className="ade-upd-version">
          {row.fromVersion ? <span className="kit-num">{row.fromVersion}</span> : <span>Version unknown</span>}
          <ArrowRight size={11} weight="bold" aria-hidden />
          <span className="kit-num ade-upd-version-to">
            {row.toVersion ?? `newest ${updateTrackLabel(row.toTrack)}`}
          </span>
          {showTracks ? <span className="ade-upd-outcome">{`· ${outcomeText(row)}`}</span> : null}
        </div>
        <div className="ade-upd-detail">
          <div className="ade-upd-headline" data-busy={busy ? "true" : undefined}>{updateImpactHeadline(impact)}</div>
          {listed.length > 0 ? (
            <ul className="ade-upd-chats">
              {listed.map((chat) => (
                <li key={chat.sessionId}>
                  <ChatCircleDots size={12} weight="fill" aria-hidden />
                  <span className="ade-upd-chat-title">{chat.title}</span>
                  {showProject ? <span className="ade-upd-chat-meta">{`— ${chat.projectName}`}</span> : null}
                  {chat.resumable === false ? <span className="ade-upd-chat-meta">— won't continue</span> : null}
                </li>
              ))}
              {unlisted > 0 ? <li className="ade-upd-chat-more">{`${unlisted} more`}</li> : null}
            </ul>
          ) : null}
          {resumable > 0 ? (
            continueControl ?? (
              <div className="ade-upd-continue" title={REMOTE_CONTINUE_CAVEAT}>
                <ArrowClockwise size={12} weight="bold" aria-hidden />
                {continuesAfterUpdateLabel(resumable)}
              </div>
            )
          ) : null}
          {note ? <div className="ade-upd-note">{note}</div> : null}
          {extra}
        </div>
      </div>
    </div>
  );
}

/** Phones connected to this computer, for its row: they drop and come back. */
export function PhonesLine({ phones }: { phones: ReadonlyArray<{ deviceId: string; deviceName: string }> }) {
  if (phones.length === 0) return null;
  const text = phones.length === 1
    ? `${phones[0]!.deviceName} reconnects after the update`
    : `${phones.length} phones reconnect after the update`;
  return (
    <div className="ade-upd-phones" title={phones.length > 1 ? phones.map((phone) => phone.deviceName).join(", ") : undefined}>
      <DeviceMobile size={12} weight="bold" aria-hidden />
      {text}
    </div>
  );
}

/** Whether any row needs its track named. */
export function rowsShowTracks(rows: readonly MachineUpdateRowModel[]): boolean {
  return rows.some((row) => row.fromTrack !== row.toTrack || row.fromTrack === "beta" || row.toTrack === "beta");
}

/**
 * Asks before "Update & restart" runs on other machines, naming what is
 * running on each. Each machine goes to a build on its own track. Resolves
 * true when the person agreed.
 */
export async function confirmMachineUpdates(
  machines: ReadonlyArray<MachineWithImpact & Pick<MachineUpdateTarget, "targetVersion">>,
): Promise<boolean> {
  if (machines.length === 0) return false;
  const single = machines.length === 1 ? machines[0]! : null;
  const rows = machines.map(remoteMachineRowModel);
  const showTracks = rowsShowTracks(rows);
  const singleVersion = single?.targetVersion
    ? single.targetVersion.trim().replace(/^v/i, "")
    : single
      ? `the newest ${updateTrackLabel(updateTrackOfVersion(single.version))}`
      : null;
  return await confirmDialog({
    title: single ? `Update ${single.name} to ${singleVersion}?` : `Update ${machines.length} machines?`,
    message: "ADE restarts there.",
    icon: <ArrowClockwise size={16} weight="bold" />,
    tone: "accent",
    size: "md",
    children: (
      <div className="ade-upd-list">
        {rows.map((row) => <MachineUpdateRow key={row.key} row={row} showTracks={showTracks} />)}
      </div>
    ),
    confirmLabel: single ? "Update & restart" : "Update all",
    cancelLabel: "Not now",
  });
}
