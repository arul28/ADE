import { useState } from "react";
import type {
  RemoteRuntimeUpdateImpact,
  UpdateInstallImpact,
  UpdateInterruptedChat,
} from "../../../shared/types";
import { isMachineVersionOutdated } from "../remoteTargets/remoteMachineModel";
import { confirmDialog } from "../ui/dialog/confirm";

/**
 * What an update stops on one machine, and the dialogs that say so before it
 * runs. Shared by this computer's install and "Update & restart" on another
 * machine, so both name running work the same way.
 */
export type RunningWork = {
  /** False when the machine did not answer: the rest means "unknown", not "none". */
  checked: boolean;
  chats: UpdateInterruptedChat[];
  cliSessions: number;
  terminals: number;
  /** The machine's ADE is too old to say what is running, only that something is. */
  busyWithoutDetail?: boolean;
};

const UNKNOWN_RUNNING_WORK: RunningWork = { checked: false, chats: [], cliSessions: 0, terminals: 0 };

/** A connected machine on an older ADE than the one being installed. */
export type OutdatedMachine = {
  id: string;
  name: string;
  version: string | null;
};

export type OutdatedMachineWork = OutdatedMachine & { work: RunningWork };

export function runningWorkFromInstallImpact(impact: UpdateInstallImpact | null): RunningWork {
  if (!impact) return UNKNOWN_RUNNING_WORK;
  return {
    checked: impact.checked !== false,
    chats: impact.interruptedChats ?? [],
    cliSessions: impact.cliSessions ?? 0,
    terminals: impact.terminals ?? 0,
  };
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line for what is running: "2 agents and 1 terminal are running". */
export function runningWorkHeadline(work: RunningWork): string {
  if (!work.checked) return "Couldn't check what's running";
  if (work.busyWithoutDetail) return "Work is running";
  const parts: string[] = [];
  if (work.chats.length > 0) parts.push(counted(work.chats.length, "agent", "agents"));
  if (work.cliSessions > 0) parts.push(counted(work.cliSessions, "CLI session", "CLI sessions"));
  if (work.terminals > 0) parts.push(counted(work.terminals, "terminal", "terminals"));
  if (parts.length === 0) return "Nothing is running";
  const total = work.chats.length + work.cliSessions + work.terminals;
  const listed = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${listed} ${total === 1 ? "is" : "are"} running`;
}

function versionLabel(version: string | null): string {
  return version ? `v${version.replace(/^v/i, "")}` : "the latest version";
}

/**
 * The running work on one machine: the headline, then the chats by name.
 * Project names only appear when the list spans more than one, so a
 * single-project list stays quiet.
 */
export function RunningWorkSummary({ work, heading }: { work: RunningWork; heading?: string }) {
  const projectNames = new Set(work.chats.map((chat) => chat.projectName).filter(Boolean));
  const showProject = projectNames.size > 1;
  const closesWithoutResume = work.cliSessions + work.terminals > 0;
  return (
    <div style={{ marginTop: 2 }}>
      {heading ? (
        <div style={{ fontSize: 11.5, color: "var(--color-muted-fg)", marginBottom: 2 }}>{heading}</div>
      ) : null}
      <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--color-fg)" }}>
        {runningWorkHeadline(work)}
      </div>
      {work.chats.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
          {work.chats.map((chat) => (
            <li key={chat.sessionId} style={{ overflowWrap: "anywhere" }}>
              {showProject ? `${chat.title} — ${chat.projectName}` : chat.title}
              {chat.resumable === false ? " (will not resume)" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {!work.checked ? (
        <div style={{ color: "var(--color-muted-fg)" }}>
          ADE did not answer in time, so agents may be running. They stop when it restarts.
        </div>
      ) : work.busyWithoutDetail ? (
        <div style={{ color: "var(--color-muted-fg)" }}>
          The ADE on that machine is too old to say what. It stops when ADE restarts.
        </div>
      ) : closesWithoutResume ? (
        <div style={{ color: "var(--color-muted-fg)", marginTop: work.chats.length > 0 ? 6 : 0 }}>
          CLI sessions and terminals close and are not restarted.
        </div>
      ) : null}
    </div>
  );
}

/** Connected machines running an ADE older than `targetVersion`. */
export async function listOutdatedConnectedMachines(
  targetVersion: string | null,
): Promise<OutdatedMachine[]> {
  if (!targetVersion) return [];
  try {
    const snapshot = await window.ade.remoteRuntime?.getConnectionSnapshot?.();
    return (snapshot?.connections ?? [])
      .filter((connection) => connection.state === "connected")
      .map((connection) => ({
        id: connection.target.id,
        name: connection.target.name,
        version: connection.version ?? connection.target.runtimeBinaryVersion ?? null,
      }))
      .filter((machine) => isMachineVersionOutdated(machine.version, targetVersion));
  } catch {
    return [];
  }
}

/** What an update would stop on each machine. A machine that cannot answer is "unknown". */
export async function readMachinesRunningWork(
  machines: readonly OutdatedMachine[],
): Promise<OutdatedMachineWork[]> {
  return await Promise.all(machines.map(async (machine) => {
    let work: RunningWork = UNKNOWN_RUNNING_WORK;
    try {
      const impact: RemoteRuntimeUpdateImpact | undefined =
        await window.ade.remoteRuntime?.getUpdateImpact?.(machine.id);
      if (impact) work = impact;
    } catch {
      // Unknown is the honest answer for a machine that did not reply.
    }
    return { ...machine, work };
  }));
}

/** One machine per block: its name and version, then what is running there. */
export function MachinesRunningWork({ machines }: { machines: readonly OutdatedMachineWork[] }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {machines.map((machine) => (
        <RunningWorkSummary
          key={machine.id}
          work={machine.work}
          heading={machine.version ? `${machine.name} · ${versionLabel(machine.version)}` : machine.name}
        />
      ))}
    </div>
  );
}

/**
 * A checkbox inside a confirm's body. The dialog resolves only yes or no, so
 * the answer is written to `choices`, which the caller reads once it resolves.
 */
export function ChoiceCheckbox<K extends string>({
  choices,
  name,
  label,
}: {
  choices: Record<K, boolean>;
  name: K;
  label: string;
}) {
  const [checked, setChecked] = useState(choices[name]);
  return (
    <label className="ade-dialog-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          choices[name] = event.target.checked;
          setChecked(event.target.checked);
        }}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Asks before "Update & restart" runs on other machines, naming what is
 * running on each. Resolves true when the person agreed.
 */
export async function confirmMachineUpdates(
  machines: readonly OutdatedMachine[],
  targetVersion: string | null,
): Promise<boolean> {
  if (machines.length === 0) return false;
  const withWork = await readMachinesRunningWork(machines);
  const single = withWork.length === 1 ? withWork[0] : null;
  return await confirmDialog({
    title: single
      ? `Update ${single.name} to ${versionLabel(targetVersion)}?`
      : `Update ${withWork.length} machines to ${versionLabel(targetVersion)}?`,
    message: single
      ? "ADE restarts on that machine, which stops what is running there. Chats pick up again on their own when the ADE app is open on it."
      : "ADE restarts on each machine, which stops what is running there. Chats pick up again on their own where the ADE app is open.",
    children: <MachinesRunningWork machines={withWork} />,
    confirmLabel: single ? "Update & restart" : "Update all",
  });
}
