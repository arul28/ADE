import { useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, WarningCircle } from "@phosphor-icons/react";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
import { cn } from "../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS } from "../ui/paneMenuTokens";

/**
 * Clone a fresh simulator, or attach one that already exists.
 *
 * ADE never downloads a runtime. Everything offered here is a simulator this
 * Mac already has, which is why the empty case links to Xcode ▸ Settings ▸
 * Components rather than offering a download this app would have to run.
 */

export type AppleDeviceCreateMode = "clone" | "attach";

export type AppleDeviceCreateSubmit = {
  mode: AppleDeviceCreateMode;
  /** udid of the simulator to clone from, or to attach. */
  simulator: string;
};

export type AppleDeviceCreateDialogProps = {
  laneName: string;
  installed: AppleInstalledSimulator[];
  /** The project's last-used clone source, pre-selected when it is still installed. */
  lastUsedUdid: string | null;
  /** udid → the lane already using it, for the attach picker's warning. */
  inUseByLane?: Record<string, string>;
  busy?: boolean;
  error?: string | null;
  onSubmit: (submit: AppleDeviceCreateSubmit) => void;
  onCancel: () => void;
  /** Opens Xcode's Components pane. Absent off macOS. */
  onOpenXcode?: () => void;
  onCopyInstallCommand?: (command: string) => void;
};

export const APPLE_INSTALL_RUNTIME_COMMAND = "xcodebuild -downloadPlatform iOS";

const CONTROL = "ade-shell-control disabled:cursor-not-allowed disabled:opacity-45";
const PICKER = cn(
  CONTROL,
  "inline-flex h-7 w-full min-w-0 items-center justify-between gap-1 px-2 font-sans text-[11px]",
);

export function familyLabel(family: AppleInstalledSimulator["family"]): string {
  switch (family) {
    case "iphone":
      return "iPhone";
    case "ipad":
      return "iPad";
    case "watch":
    default:
      return "Apple Watch";
  }
}

/**
 * Newest first, grouped by family, iPhone before iPad before Watch.
 *
 * "Newest" is the runtime string in descending order: the list `simctl` hands
 * back is device-type order, which puts an iPhone 12 above an iPhone 17.
 */
export function groupInstalledSimulators(
  installed: readonly AppleInstalledSimulator[],
): Array<{ family: AppleInstalledSimulator["family"]; simulators: AppleInstalledSimulator[] }> {
  const order: AppleInstalledSimulator["family"][] = ["iphone", "ipad", "watch"];
  return order
    .map((family) => ({
      family,
      simulators: installed
        .filter((simulator) => simulator.family === family)
        .sort((left, right) => (
          right.runtime.localeCompare(left.runtime, undefined, { numeric: true })
          || right.name.localeCompare(left.name, undefined, { numeric: true })
        )),
    }))
    .filter((group) => group.simulators.length > 0);
}

/** Booted first, then the same ordering the clone list uses. */
export function sortAttachCandidates(
  installed: readonly AppleInstalledSimulator[],
): AppleInstalledSimulator[] {
  return [...installed].sort((left, right) => {
    const leftBooted = left.state === "Booted" ? 1 : 0;
    const rightBooted = right.state === "Booted" ? 1 : 0;
    if (leftBooted !== rightBooted) return rightBooted - leftBooted;
    return right.runtime.localeCompare(left.runtime, undefined, { numeric: true });
  });
}

/** `<source name> — <lane name>`, truncated to 60 characters. */
export function proposeCloneName(sourceName: string, laneName: string): string {
  const proposed = `${sourceName} — ${laneName}`;
  return proposed.length <= 60 ? proposed : `${proposed.slice(0, 59).trimEnd()}…`;
}

function SimulatorPicker({
  simulators,
  value,
  disabledFamilies,
  noteFor,
  onChange,
  grouped,
  ariaLabel,
}: {
  simulators: AppleInstalledSimulator[];
  value: string | null;
  disabledFamilies?: AppleInstalledSimulator["family"][];
  noteFor?: (simulator: AppleInstalledSimulator) => string | null;
  onChange: (udid: string) => void;
  grouped: boolean;
  ariaLabel: string;
}) {
  const selected = simulators.find((simulator) => simulator.udid === value) ?? null;
  const groups = grouped
    ? groupInstalledSimulators(simulators)
    : [{ family: "iphone" as const, simulators }];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={PICKER} aria-label={ariaLabel}>
          <span className="min-w-0 truncate">
            {selected ? `${selected.name} · ${selected.runtime}` : "Choose a simulator"}
          </span>
          <CaretDown size={11} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} align="start" sideOffset={4}>
          {groups.map((group) => (
            <div key={group.family}>
              {grouped ? <div className={MENU_LABEL_CLASS}>{familyLabel(group.family)}</div> : null}
              {group.simulators.map((simulator) => {
                const familyDisabled = disabledFamilies?.includes(simulator.family) ?? false;
                const note = familyDisabled
                  ? "Watch support is coming"
                  : noteFor?.(simulator) ?? null;
                return (
                  <DropdownMenu.Item
                    key={simulator.udid}
                    className={MENU_ITEM_CLASS}
                    disabled={familyDisabled}
                    onSelect={() => {
                      if (familyDisabled) return;
                      onChange(simulator.udid);
                    }}
                  >
                    <span className="min-w-0 truncate">
                      {simulator.name} · {simulator.runtime}
                      {simulator.state === "Booted" ? " (booted)" : ""}
                    </span>
                    {note ? (
                      <span className="ml-2 shrink-0 text-[10px] text-muted-fg/60">{note}</span>
                    ) : null}
                  </DropdownMenu.Item>
                );
              })}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AppleDeviceCreateDialog({
  laneName,
  installed,
  lastUsedUdid,
  inUseByLane = {},
  busy = false,
  error = null,
  onSubmit,
  onCancel,
  onOpenXcode,
  onCopyInstallCommand,
}: AppleDeviceCreateDialogProps) {
  const [mode, setMode] = useState<AppleDeviceCreateMode>("clone");
  const cloneCandidates = useMemo(
    () => installed.filter((simulator) => simulator.isAvailable),
    [installed],
  );
  const attachCandidates = useMemo(() => sortAttachCandidates(installed), [installed]);

  /**
   * The project's last-used source, else the newest installed iPhone — exactly
   * what an agent's first `launch` would clone, so the dialog and the silent
   * path never disagree about what "a device for this lane" means.
   */
  const defaultClone = useMemo(() => {
    const remembered = cloneCandidates.find((simulator) => simulator.udid === lastUsedUdid);
    if (remembered) return remembered.udid;
    const iphones = groupInstalledSimulators(cloneCandidates).find((group) => group.family === "iphone");
    return iphones?.simulators[0]?.udid ?? cloneCandidates[0]?.udid ?? null;
  }, [cloneCandidates, lastUsedUdid]);

  const [cloneUdid, setCloneUdid] = useState<string | null>(defaultClone);
  const [attachUdid, setAttachUdid] = useState<string | null>(attachCandidates[0]?.udid ?? null);

  useEffect(() => {
    setCloneUdid((current) => current ?? defaultClone);
  }, [defaultClone]);

  const cloneSource = cloneCandidates.find((simulator) => simulator.udid === cloneUdid) ?? null;
  const attachTarget = attachCandidates.find((simulator) => simulator.udid === attachUdid) ?? null;
  const attachConflictLane = attachTarget ? inUseByLane[attachTarget.udid] ?? null : null;
  const selectedUdid = mode === "clone" ? cloneUdid : attachUdid;
  const empty = installed.length === 0;

  return (
    <div
      role="dialog"
      aria-label={`New device for ${laneName}`}
      data-apple-create-dialog=""
      className="flex w-full max-w-[420px] flex-col gap-3 rounded-lg border border-white/[0.08] bg-card/95 p-3 shadow-xl"
    >
      <div className="font-sans text-[12px] font-medium text-fg/88">New device for {laneName}</div>

      {empty ? (
        <div className="flex flex-col gap-2">
          <div className="font-sans text-[11px] text-fg/80">No simulators installed</div>
          <div className="font-sans text-[11px] leading-5 text-muted-fg/70">
            ADE only uses simulators you already have. Install one in Xcode ▸ Settings ▸ Components.
          </div>
          <div className="flex items-center gap-1.5">
            {onOpenXcode ? (
              <button type="button" className={cn(CONTROL, "h-7 px-2 font-sans text-[11px]")} onClick={onOpenXcode}>
                Open Xcode
              </button>
            ) : null}
            {onCopyInstallCommand ? (
              <button
                type="button"
                className={cn(CONTROL, "h-7 px-2 font-sans text-[11px]")}
                onClick={() => onCopyInstallCommand(APPLE_INSTALL_RUNTIME_COMMAND)}
              >
                Copy command
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5">
              <input
                type="radio"
                name="apple-create-mode"
                checked={mode === "clone"}
                onChange={() => setMode("clone")}
              />
              <span className="font-sans text-[11px] text-fg/85">Clone a fresh simulator</span>
              <span className="font-sans text-[10px] text-muted-fg/55">recommended</span>
            </span>
            <div className="pl-5">
              <SimulatorPicker
                ariaLabel="Simulator to clone"
                simulators={cloneCandidates}
                value={cloneUdid}
                grouped
                disabledFamilies={["watch"]}
                onChange={setCloneUdid}
              />
              {cloneSource ? (
                <div className="mt-1 font-sans text-[10px] leading-4 text-muted-fg/62">
                  Named “{proposeCloneName(cloneSource.name, laneName)}”. Deleted when the lane is archived.
                </div>
              ) : null}
            </div>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5">
              <input
                type="radio"
                name="apple-create-mode"
                checked={mode === "attach"}
                onChange={() => setMode("attach")}
              />
              <span className="font-sans text-[11px] text-fg/85">Attach an existing simulator</span>
            </span>
            <div className="pl-5">
              <SimulatorPicker
                ariaLabel="Simulator to attach"
                simulators={attachCandidates}
                value={attachUdid}
                grouped={false}
                noteFor={(simulator) => {
                  const lane = inUseByLane[simulator.udid];
                  return lane ? `in use by ${lane}` : null;
                }}
                onChange={setAttachUdid}
              />
              <div className="mt-1 font-sans text-[10px] leading-4 text-muted-fg/62">
                Not cloned, not deleted. Shared with anything else using it.
              </div>
              {mode === "attach" && attachConflictLane ? (
                <div className="mt-1 flex items-start gap-1.5 font-sans text-[10px] leading-4 text-amber-100/80">
                  <WarningCircle size={12} weight="fill" className="mt-px shrink-0 text-amber-200/85" />
                  Another lane is using this simulator. Changes affect both.
                </div>
              ) : null}
            </div>
          </label>

          <div className="border-t border-white/[0.06] pt-2 font-sans text-[10px] leading-4 text-muted-fg/62">
            Only simulators already installed appear here.
            {onOpenXcode ? (
              <button
                type="button"
                className="ml-1 underline decoration-dotted underline-offset-2 hover:text-fg/80"
                onClick={onOpenXcode}
              >
                Open Xcode to install more
              </button>
            ) : null}
          </div>
        </>
      )}

      {error ? (
        <div className="font-sans text-[10px] leading-4 text-rose-100/85">{error}</div>
      ) : null}

      <div className="flex items-center justify-end gap-1.5">
        <button type="button" className={cn(CONTROL, "h-7 px-2 font-sans text-[11px]")} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={cn(
            CONTROL,
            "h-7 px-2 font-sans text-[11px] font-medium",
            "!border-cyan-300/30 !bg-cyan-400/15 text-cyan-50/92",
          )}
          disabled={busy || !selectedUdid}
          onClick={() => {
            if (!selectedUdid) return;
            onSubmit({ mode, simulator: selectedUdid });
          }}
        >
          {mode === "clone" ? "Create" : "Attach"}
        </button>
      </div>
    </div>
  );
}
