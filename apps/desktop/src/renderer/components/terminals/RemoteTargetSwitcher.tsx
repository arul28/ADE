import { useState } from "react";
import { remoteWorkUseKey } from "../../../shared/chatRemoteWork";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import { useRemoteWorkPinResolver } from "../../lib/remoteWorkPins";
import { MachinePlatformLogo } from "../remoteTargets/MachineIdentity";
import { cn } from "../ui/cn";
import { WORK_TOOL_CHROME_CHIP, WORK_TOOL_CHROME_ROW } from "./workToolChrome";

type RemoteWorkTargetUse = AgentChatRemoteWorkUse & { workCopyLaneId: string };

type RemoteTargetOption = {
  key: string;
  label: string;
  /** The other machine's work copy, or null for this lane. */
  use: RemoteWorkTargetUse | null;
};

/**
 * Which device a screen tool shows: one per machine the chat drove a device
 * on through its work copy there, then this lane's own. The newest machine
 * the chat used comes first, unless the user picked another.
 */
export function useRemoteTargetChoice(remoteUses: RemoteWorkTargetUse[], laneAvailable: boolean) {
  const resolvePin = useRemoteWorkPinResolver(remoteUses.length > 0);
  const options: RemoteTargetOption[] = [
    ...remoteUses.map((use) => ({ key: remoteWorkUseKey(use), label: use.machineName, use })),
    ...(laneAvailable ? [{ key: "lane", label: "This lane", use: null }] : []),
  ];
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const chosen = options.find((option) => option.key === chosenKey) ?? options[0] ?? null;
  return { options, chosen, choose: setChosenKey, resolvePin };
}

/** One chip per target, shown only when there is more than one. */
export function RemoteTargetSwitcher({
  options,
  chosenKey,
  onChoose,
  remoteLabel,
  testId,
}: {
  options: RemoteTargetOption[];
  chosenKey: string | null;
  onChoose: (key: string) => void;
  /** The word before a machine's name: `Simulator · Studio Mac`. */
  remoteLabel: string;
  testId: string;
}) {
  if (options.length <= 1) return null;
  return (
    <div className={WORK_TOOL_CHROME_ROW} data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChoose(option.key)}
          className={cn(WORK_TOOL_CHROME_CHIP, option.key === chosenKey ? "bg-fg/[0.08] text-fg" : "")}
        >
          {option.use ? <MachinePlatformLogo platform={option.use.machinePlatform} size={12} weight="bold" fallback /> : null}
          <span>{option.use ? `${remoteLabel} · ${option.label}` : option.label}</span>
        </button>
      ))}
    </div>
  );
}
