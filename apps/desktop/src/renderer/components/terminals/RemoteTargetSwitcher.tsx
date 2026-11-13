import { useCallback, useState } from "react";
import { remoteWorkUseKey, type RemoteWorkCopyUse } from "../../../shared/chatRemoteWork";
import { MachinePlatformLogo } from "../remoteTargets/MachineIdentity";
import { cn } from "../ui/cn";
import { WORK_TOOL_CHROME_CHIP, WORK_TOOL_CHROME_ROW } from "./workToolChrome";

type RemoteTargetOption = {
  key: string;
  label: string;
  /** The other machine's work copy, or null for this lane. */
  use: RemoteWorkCopyUse | null;
};

/*
 * Per chat and tool, for this window's life: the target the person picked, and
 * the uses whose machine said it has no device for them. A use is keyed with
 * its `lastStartedAt`, so newer work there asks again.
 */
const PICKED_TARGETS = new Map<string, string>();
const DEVICELESS_USES = new Map<string, ReadonlySet<string>>();
const NO_KEYS: ReadonlySet<string> = new Set();
const MAX_REMEMBERED = 200;

function remember<T>(map: Map<string, T>, key: string | null, value: T): void {
  if (key === null) return;
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!);
}

function recalled<T>(map: Map<string, T>, key: string | null): T | undefined {
  return key === null ? undefined : map.get(key);
}

function devicelessKey(use: RemoteWorkCopyUse): string {
  return `${remoteWorkUseKey(use)}@${use.lastStartedAt}`;
}

/**
 * Which device a screen tool shows: one per machine the chat drove a device
 * on through its work copy there, then this lane's own.
 *
 * The default is the newest use whose machine has a device for it
 * (`reportDevice`), else the newest: `lastStartedAt` moves with any command
 * there, so a machine the chat only ran a shell on can be newer than the one
 * whose emulator it drove. A person's pick holds for this chat and tool until
 * the window closes. `stickyKey` names the chat and tool; null (no chat)
 * remembers nothing past this pane.
 */
export function useRemoteTargetChoice(remoteUses: RemoteWorkCopyUse[], laneAvailable: boolean, stickyKey: string | null) {
  const options: RemoteTargetOption[] = [
    ...remoteUses.map((use) => ({ key: remoteWorkUseKey(use), label: use.machineName, use })),
    ...(laneAvailable ? [{ key: "lane", label: "This lane", use: null }] : []),
  ];
  const [pickedKey, setPickedKey] = useState<string | null>(() => recalled(PICKED_TARGETS, stickyKey) ?? null);
  const [deviceless, setDeviceless] = useState<ReadonlySet<string>>(() => recalled(DEVICELESS_USES, stickyKey) ?? NO_KEYS);
  // Another chat in the same pane: its own pick and its own readings.
  const [stickySeen, setStickySeen] = useState(stickyKey);
  if (stickySeen !== stickyKey) {
    setStickySeen(stickyKey);
    setPickedKey(recalled(PICKED_TARGETS, stickyKey) ?? null);
    setDeviceless(recalled(DEVICELESS_USES, stickyKey) ?? NO_KEYS);
  }
  const picked = options.find((option) => option.key === pickedKey) ?? null;
  const chosen = picked
    ?? options.find((option) => option.use && !deviceless.has(devicelessKey(option.use)))
    ?? options[0]
    ?? null;
  const choose = useCallback((key: string) => {
    remember(PICKED_TARGETS, stickyKey, key);
    setPickedKey(key);
  }, [stickyKey]);
  const reportDevice = useCallback((use: RemoteWorkCopyUse, hasDevice: boolean) => {
    const key = devicelessKey(use);
    setDeviceless((current) => {
      if (current.has(key) === !hasDevice) return current;
      const next = new Set(current);
      if (hasDevice) next.delete(key);
      else next.add(key);
      remember(DEVICELESS_USES, stickyKey, next);
      return next;
    });
  }, [stickyKey]);
  return { options, chosen, choose, reportDevice };
}

/**
 * One chip per target, shown when there is more than one, or when the only
 * one is another machine's: then the chip is what says whose device it is.
 */
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
  if (options.length === 0 || (options.length === 1 && !options[0]!.use)) return null;
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
