import type { UpdateImpact } from "../../../shared/types";
import { updateVersionLabel } from "../../../shared/updateVersions";
import { confirmDialog } from "../ui/dialog/confirm";
import type { ConnectedMachine } from "./remoteMachineModel";

/**
 * What an update stops on a machine, in words. Shared by this computer's
 * install dialog and "Update & restart" on another machine, so both name
 * running work the same way.
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

function impactNote(impact: UpdateImpact): string | null {
  if (!impact.checked) {
    return "ADE did not answer in time, so work may be running. It stops when ADE restarts.";
  }
  if (impact.busyWithoutDetail) {
    return "That ADE is too old to say what else is running. It stops when ADE restarts.";
  }
  if (impact.cliSessions + impact.terminals > 0) {
    return "CLI sessions and terminals close and are not restarted.";
  }
  return null;
}

/**
 * The work running on one machine: an optional label, the headline, then the
 * chats by name. Project names only appear when the list spans more than one,
 * so a single-project list stays quiet.
 */
export function UpdateImpactSummary({ impact, label }: { impact: UpdateImpact; label?: string }) {
  const projectNames = new Set(impact.chats.map((chat) => chat.projectName).filter(Boolean));
  const showProject = projectNames.size > 1;
  const note = impactNote(impact);
  return (
    <div className="ade-dialog-impact-block">
      {label ? <div className="ade-dialog-impact-label">{label}</div> : null}
      <div className="ade-dialog-impact-headline">{updateImpactHeadline(impact)}</div>
      {impact.chats.length > 0 ? (
        <ul className="ade-dialog-impact-list">
          {impact.chats.map((chat) => (
            <li key={chat.sessionId}>
              {showProject ? `${chat.title} — ${chat.projectName}` : chat.title}
              {chat.resumable === false ? " (will not resume)" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <div className="ade-dialog-impact-note">{note}</div> : null}
    </div>
  );
}

function machineLabel(machine: ConnectedMachine): string {
  // Both versions when the app and brain there drift ("1.2.123 · brain 1.2.125").
  if (machine.versionLabel && machine.versionLabel !== machine.version) return `${machine.name} · ${machine.versionLabel}`;
  return machine.version ? `${machine.name} · ${updateVersionLabel(machine.version, "")}` : machine.name;
}

/** One block per machine: its name and version, then what is running there. */
export function MachinesUpdateImpact({ machines }: { machines: readonly MachineWithImpact[] }) {
  return (
    <>
      {machines.map((machine) => (
        <UpdateImpactSummary key={machine.id} impact={machine.impact} label={machineLabel(machine)} />
      ))}
    </>
  );
}

/**
 * Asks before "Update & restart" runs on other machines, naming what is
 * running on each. Resolves true when the person agreed.
 */
export async function confirmMachineUpdates(
  machines: readonly MachineWithImpact[],
  targetVersion: string | null,
): Promise<boolean> {
  if (machines.length === 0) return false;
  const single = machines.length === 1 ? machines[0] : null;
  const version = updateVersionLabel(targetVersion, "the latest version");
  return await confirmDialog({
    title: single ? `Update ${single.name} to ${version}?` : `Update ${machines.length} machines to ${version}?`,
    message: "ADE restarts there, which stops what is running. Where the ADE app is open, its chats pick up again after the update.",
    children: (
      <div className="ade-dialog-impact">
        <MachinesUpdateImpact machines={machines} />
      </div>
    ),
    confirmLabel: single ? "Update & restart" : "Update all",
  });
}
