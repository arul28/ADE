import { useMemo, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowsClockwise, Copy, DotsThree } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type {
  AppleDeviceDiskUsage,
  AppleInstalledRuntime,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleLaneDeviceFamily,
  AppleMissingRuntime,
  AppleNewDeviceSpec,
  AppleRuntimeInstallState,
  AppleRuntimeInventory,
  AppleRuntimeSimulatorDisposition,
  AppleSimulatorOwner,
  AppleSimulatorOwnershipInfo,
} from "../../../shared/types/iosSimulator";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../ui/paneMenuTokens";
import {
  AppleDeviceIPadGlyph,
  AppleDeviceIPhoneGlyph,
  AppleDeviceTvGlyph,
  AppleDeviceVisionGlyph,
  AppleDeviceWatchGlyph,
  AppleLogo,
} from "../ui/appleIcons";
import {
  appleDeviceIdentity,
  groupAppleSimulatorsByFamily,
  type AppleDeviceFamilyId,
} from "./appleDeviceFamily";
import { isAppleSimulatorBooted } from "./appleDeviceState";
import { DangerConfirmMenuItem } from "./DangerConfirmMenuItem";
import { DrawerMenu, type DrawerMenuOption } from "./drawer/drawerPrimitives";
import {
  appleDeviceDiskLabel,
  appleDiskLabel,
  appleDiskTotalLabel,
  appleOwnerLaneLabel,
  partitionApplePickerDevices,
} from "./applePickerInventory";
import { AppleRuntimeInstallProgress, AppleRuntimesSection, AppleXcodeNote } from "./AppleRuntimesSection";
import { appleRuntimeInstallActive } from "../../../shared/appleRuntimeVersions";
import { AppleSpinner } from "./AppleSpinner";
import { useTicker } from "../../lib/ticker";

/**
 * The pane's front door: an "Available" heading with one glyph per installed
 * device, a group per device family, one card per device (a device another
 * lane holds says TAKEN and cannot be started here), and "Create a new one" at
 * the foot. Refresh sits at the top right.
 */

export type AppleDevicePickerProps = {
  installed: readonly AppleInstalledSimulator[];
  /**
   * `deviceList().owners` — every lane's binding, this lane's flagged `mine`.
   *
   * Absent means "ownership unknown", which the page renders as everything
   * being free. That is only reachable from a host too old to answer; the live
   * payload always carries it.
   */
  owners?: readonly AppleSimulatorOwner[] | null;
  /** `deviceList().lane` — this lane's device, or null when it owns none. */
  laneDevice?: AppleLaneDevice | null;
  /** `deviceList({ disk: true }).disk`, which lands after the first paint. */
  disk?: AppleDeviceDiskUsage | null;
  /** True while that second, disk-only read is in flight. */
  measuringDisk?: boolean;
  /** `deviceList({ runtimes: true }).runtimes`: what a new device can run. */
  runtimes?: readonly AppleInstalledRuntime[] | null;
  /** `deviceList({ runtimes: true }).defaultNewDevice`: where the Create control starts. */
  defaultNewDevice?: AppleNewDeviceSpec | null;
  /** `deviceList({ disk: true }).ownership`: who each device belongs to. */
  ownership?: readonly AppleSimulatorOwnershipInfo[] | null;
  /** The udid a start is in flight for, or `"create"` while making a new device. */
  pending: string | null;
  refreshing: boolean;
  onStart: (udid: string) => void;
  onCreate: (spec: AppleNewDeviceSpec) => void;
  /** Run the cleanup pass now. Absent hides the button. */
  onCleanup?: () => void;
  /** True while that pass runs. */
  cleaning?: boolean;
  /** Delete one installed simulator. Only ever offered for a device no lane holds. */
  onDelete?: (udid: string) => void;
  onRefresh: () => void;
  /** False pauses the backdrop's loop, exactly as on the tools grid. */
  playing?: boolean;
  /** `runtimeList()`: installed runtimes, the one this Xcode expects, the running download, Xcode itself. */
  runtimeInventory?: AppleRuntimeInventory | null;
  /** A runtime remove or prune is running. */
  removingRuntime?: boolean;
  /** Download what this Xcode needs, then create `deviceType` on it. */
  onInstallAndCreate?: (deviceType: string) => void;
  onCancelInstall?: () => void;
  onRemoveRuntime?: (id: string, simulators: AppleRuntimeSimulatorDisposition) => void;
  onPruneRuntimes?: (simulators: AppleRuntimeSimulatorDisposition) => void;
  onRunXcodeSetup?: () => Promise<void>;
};

/** The column the page is built around — the tools grid's 512 plus one card. */
const COLUMN_MAX_PX = 560;

/** Two cards at 432px of pane, one below it. Mirrors `WorkToolPicker`. */
const CARD_MIN_TRACK_PX = 188;

const FAMILY_GLYPH: Record<AppleDeviceFamilyId, Icon> = {
  iphone: AppleDeviceIPhoneGlyph,
  ipad: AppleDeviceIPadGlyph,
  watch: AppleDeviceWatchGlyph,
  tv: AppleDeviceTvGlyph,
  vision: AppleDeviceVisionGlyph,
  other: AppleDeviceIPhoneGlyph,
};

/**
 * `iOS 26.3 · iPhone 15 Pro`, which is the OS and the device the owner asked
 * for, on the line under the name.
 *
 * The model is always spelled out here, even when the name already contains it.
 * A card that shows the model only for a RENAMED device makes the two kinds of
 * card different heights, and a grid of cards that disagree about their own
 * line count looks broken rather than informative.
 */
function specLine(simulator: AppleInstalledSimulator): string {
  const model = appleDeviceIdentity(simulator).model;
  return model ? `${simulator.runtime} · ${model}` : simulator.runtime;
}

export function AppleDevicePicker({
  installed,
  owners,
  laneDevice,
  disk,
  measuringDisk = false,
  runtimes,
  defaultNewDevice,
  ownership,
  pending,
  refreshing,
  onStart,
  onCreate,
  onCleanup,
  cleaning = false,
  onDelete,
  onRefresh,
  playing = true,
  runtimeInventory,
  removingRuntime = false,
  onInstallAndCreate,
  onCancelInstall,
  onRemoveRuntime,
  onPruneRuntimes,
  onRunXcodeSetup,
}: AppleDevicePickerProps) {
  const theme = useAppStore((s) => s.theme);

  const partition = useMemo(
    () => partitionApplePickerDevices({ installed, owners, laneDevice }),
    [installed, laneDevice, owners],
  );

  // Family is the only grouping; what a device is to this lane is a tag on its
  // card, so the count beside "Available" matches the cards on the page.
  const groups = useMemo(() => groupAppleSimulatorsByFamily(installed), [installed]);
  /** Devices another lane holds, with who holds them. */
  const takenBy = useMemo(
    () => new Map(partition.elsewhere.map((entry) => [entry.simulator.udid, entry.owner])),
    [partition.elsewhere],
  );

  const ownershipBy = useMemo(
    () => new Map((ownership ?? []).map((entry) => [entry.udid, entry])),
    [ownership],
  );

  const busy = pending !== null;
  const missingRuntime = onInstallAndCreate ? runtimeInventory?.missing ?? null : null;
  const canCreate = (runtimes ?? []).some((runtime) => runtime.deviceTypes.length > 0) || Boolean(missingRuntime);
  const xcodeNote = onRunXcodeSetup ? <AppleXcodeNote xcode={runtimeInventory?.xcode} onRunSetup={onRunXcodeSetup} /> : null;

  return (
    <PickerPage theme={theme} playing={playing}>
      {xcodeNote}
      {installed.length === 0 && !canCreate ? (
        <EmptyCard refreshing={refreshing} onRefresh={onRefresh} />
      ) : (
        <>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <AvailableHeading
              groups={groups}
              takenBy={takenBy}
              installedCount={installed.length}
              freeCount={partition.available.length}
            />
            <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
          </div>

          {groups.map((group) => (
            <section
              key={group.family}
              aria-label={group.label}
              data-apple-family={group.family}
              className="flex min-w-0 flex-col gap-2"
            >
              <h4 className="px-0.5 font-sans text-[11px] font-medium leading-4 text-fg/70">
                {group.label}
              </h4>
              <div
                className="grid min-w-0 gap-2"
                style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${CARD_MIN_TRACK_PX}px), 1fr))` }}
              >
                {group.devices.map((simulator) => (
                  <DeviceCard
                    key={simulator.udid}
                    simulator={simulator}
                    family={group.family}
                    owner={takenBy.get(simulator.udid) ?? null}
                    mine={partition.mine?.udid === simulator.udid}
                    ownership={ownershipBy.get(simulator.udid) ?? null}
                    disk={disk}
                    pending={pending === simulator.udid}
                    disabled={busy}
                    onStart={() => onStart(simulator.udid)}
                    {...(onDelete ? { onDelete: () => onDelete(simulator.udid) } : {})}
                  />
                ))}
              </div>
            </section>
          ))}

          <CreateSection
            runtimes={runtimes ?? []}
            defaultSpec={defaultNewDevice ?? null}
            missing={partition.laneDeviceMissing ? laneDevice : null}
            disabled={busy}
            creating={pending === "create"}
            onCreate={onCreate}
            missingRuntime={missingRuntime}
            install={runtimeInventory?.install ?? null}
            {...(onInstallAndCreate ? { onInstallAndCreate } : {})}
            {...(onCancelInstall ? { onCancelInstall } : {})}
          />

          {onRemoveRuntime && onPruneRuntimes ? (
            <AppleRuntimesSection
              inventory={runtimeInventory ?? null}
              removing={removingRuntime}
              disabled={busy}
              onRemove={onRemoveRuntime}
              onPrune={onPruneRuntimes}
            />
          ) : null}

          <StorageSection
            disk={disk}
            measuringDisk={measuringDisk}
            ownership={ownership ?? []}
            installedCount={installed.length}
            cleaning={cleaning}
            disabled={busy}
            {...(onCleanup ? { onCleanup } : {})}
          />
        </>
      )}
    </PickerPage>
  );
}

/**
 * The page itself: the tools grid's backdrop, its scroller and its column.
 *
 * Two boxes, for the same reason `WorkToolPicker` uses two — `inset: 0` inside
 * a scroller resolves against the scroll ORIGIN, so a mesh painted inside it
 * ends at the fold.
 */
function PickerPage({
  theme,
  playing,
  children,
}: {
  theme: Parameters<typeof WorkToolPickerBackdrop>[0]["theme"];
  playing: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ade-pane-chrome relative h-full min-h-0 min-w-0" data-apple-picker="">
      <WorkToolPickerBackdrop theme={theme} playing={playing} />
      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
        <div
          className="relative mx-auto flex w-full min-w-0 flex-col gap-4 px-5 py-6"
          style={{ maxWidth: COLUMN_MAX_PX }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * `AVAILABLE   ▯▯▯ ▭▭` — the word, a space, then the owner's devices as icons.
 *
 * His instruction, and it does a job prose was doing badly: five simulators
 * described as "5 simulators installed · 2 running" is a sentence to parse,
 * while five glyphs grouped by family is a shape to recognise. The glyphs are
 * set at the heading's own size so the row reads as one line and not as a
 * toolbar, and a device another lane holds is dimmed — it is still his, it is
 * just not his to click right now.
 *
 * The count beside the word is the FREE devices, because that is what
 * "available" means. The glyphs are all of them.
 */
function AvailableHeading({
  groups,
  takenBy,
  installedCount,
  freeCount,
}: {
  groups: ReturnType<typeof groupAppleSimulatorsByFamily>;
  takenBy: ReadonlyMap<string, AppleSimulatorOwner>;
  installedCount: number;
  freeCount: number;
}) {
  return (
    <h3
      data-apple-picker-section="Available"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg"
    >
      <span className="min-w-0">Available</span>
      <span data-apple-available-count="" className="shrink-0 font-normal normal-case tracking-normal text-fg/60">
        {freeCount}
      </span>
      <span data-apple-inventory-glyphs="" className="ml-2 flex shrink-0 items-center gap-2">
        {groups.map((group) => {
          const Glyph = FAMILY_GLYPH[group.family];
          return (
            <span key={group.family} className="flex shrink-0 items-center gap-0.5">
              {group.devices.map((simulator) => (
                <Glyph
                  key={simulator.udid}
                  size={15}
                  aria-hidden="true"
                  data-apple-glyph={takenBy.has(simulator.udid) ? "taken" : "free"}
                  className={cn(
                    "shrink-0",
                    takenBy.has(simulator.udid) ? "text-muted-fg/55" : "text-fg",
                  )}
                />
              ))}
            </span>
          );
        })}
      </span>
      <span className="sr-only">
        {`${installedCount} installed, ${freeCount} available`}
      </span>
    </h3>
  );
}

/**
 * One device: glyph, name, OS and model, a state tag, and a menu.
 *
 * Two shapes, not two components, because they must be the same size. A free
 * device is a button and the whole card starts it. A device another lane holds
 * is a plain div: it says TAKEN, it carries no menu, and it does not respond to
 * a click. Round 5 offered "Take over…" here and the owner asked for it to go —
 * a device on hold by a working lane is not a choice this panel should present.
 */
function DeviceCard({
  simulator,
  family,
  owner,
  mine,
  ownership,
  disk,
  pending,
  disabled,
  onStart,
  onDelete,
}: {
  simulator: AppleInstalledSimulator;
  family: AppleDeviceFamilyId;
  /** Set when another lane holds this device. */
  owner: AppleSimulatorOwner | null;
  /** Set when THIS lane holds it — reachable only from a half-started state. */
  mine: boolean;
  /** Who the device belongs to, once the storage read lands. */
  ownership: AppleSimulatorOwnershipInfo | null;
  disk: AppleDeviceDiskUsage | null | undefined;
  pending: boolean;
  disabled: boolean;
  onStart: () => void;
  onDelete?: () => void;
}) {
  const Glyph = FAMILY_GLYPH[family];
  const booted = isAppleSimulatorBooted(simulator);
  const size = appleDeviceDiskLabel(disk, simulator.udid);

  if (owner) {
    return (
      <div
        data-apple-device-card={simulator.udid}
        data-apple-device-taken=""
        className="ade-tool-card ade-tool-card-solid flex min-w-0 items-start gap-2 p-3"
      >
        <Glyph size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-fg/60" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg/60">
              {simulator.name}
            </span>
            <PaneTooltip label={`On hold by ${appleOwnerLaneLabel(owner)}`} side="bottom">
              <span
                data-apple-owner-lane={owner.laneId}
                className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-warning"
              >
                Taken
              </span>
            </PaneTooltip>
          </div>
          <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
            {specLine(simulator)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-apple-device-card={simulator.udid}
      className={cn(
        "ade-tool-card group relative flex min-w-0 items-start gap-2 p-3",
        disabled && "opacity-50",
      )}
    >
      <button
        type="button"
        disabled={disabled}
        aria-label={`${booted ? "Open" : "Start"} ${simulator.name}`}
        data-apple-device-start={simulator.udid}
        onClick={onStart}
        className={cn(
          "flex min-w-0 flex-1 items-start gap-2 text-left",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <Glyph
          size={16}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-muted-fg transition-colors duration-[160ms] ease-out group-hover:text-accent"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg">
              {simulator.name}
            </span>
            {pending ? <AppleSpinner /> : mine ? (
              <span className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-accent">
                Yours
              </span>
            ) : ownership?.ownership === "ade-orphan" && ownership.deletesAfter ? (
              <ReleasedDeviceTag deletesAfter={ownership.deletesAfter} />
            ) : ownership?.ownership === "ade-kept" ? (
              <PaneTooltip label="ADE made this device, and it was released and kept as a free simulator. ADE does not delete it; start it to give it to this lane, or delete it from its menu." side="bottom">
                <span
                  data-apple-device-kept=""
                  className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg"
                >
                  Kept
                </span>
              </PaneTooltip>
            ) : ownership?.ownership === "ade-orphan" ? (
              <PaneTooltip label="ADE made this device and no lane holds it. Clean up deletes it." side="bottom">
                <span
                  data-apple-device-leftover=""
                  className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-warning"
                >
                  Leftover
                </span>
              </PaneTooltip>
            ) : booted ? (
              <span className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-success">
                Running
              </span>
            ) : ownership?.looksLikeAde ? (
              <PaneTooltip label="Named like an ADE device, but made before ADE marked its devices. Delete it here if you do not use it." side="bottom">
                <span
                  data-apple-device-unmarked=""
                  className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg"
                >
                  Old ADE?
                </span>
              </PaneTooltip>
            ) : null}
          </span>
          <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
            {specLine(simulator)}
          </span>
        </span>
      </button>
      {onDelete ? (
        <DeviceMenu
          simulator={simulator}
          size={size}
          disabled={disabled}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );
}

/**
 * A device a lane released that ADE made: the cleanup pass deletes it once
 * the grace runs out (at its next run, so "soon" after that). Starting the
 * card takes it back for this lane before then, which the tag says. One
 * shared 30-second tick counts it down, and only while such a card is shown.
 */
function ReleasedDeviceTag({ deletesAfter }: { deletesAfter: string }) {
  const now = useTicker(30_000);
  const leftMs = Date.parse(deletesAfter) - now;
  const minutes = Math.ceil(leftMs / 60_000);
  const when = Number.isFinite(leftMs) && minutes > 0 ? `in ${minutes} min` : "soon";
  return (
    <PaneTooltip
      label={`ADE made this device and a lane released it. ADE deletes it ${when === "soon" ? "at its next cleanup" : when}, with its apps and data. Start it to take it back for this lane.`}
      side="bottom"
    >
      <span
        data-apple-device-pending-delete={deletesAfter}
        className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-warning"
      >
        {`Deletes ${when}`}
      </span>
    </PaneTooltip>
  );
}

/**
 * The per-device menu the owner asked for.
 *
 * Two items, and the second one is why it exists: he is short of disk and a
 * simulator he is finished with is several gigabytes. It names the measured
 * size in the confirmation, because "delete iPhone 17e" and "delete iPhone
 * 17e, 3.2 GB" are different decisions.
 *
 * There is no menu at all on a device another lane holds — not a disabled one.
 * A greyed Delete invites a second click to find out why; an absent one says
 * the card is not yours to act on, which the TAKEN tag already said.
 */
function DeviceMenu({
  simulator,
  size,
  disabled,
  onDelete,
}: {
  simulator: AppleInstalledSimulator;
  size: string | null;
  disabled: boolean;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setConfirming(false);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Manage ${simulator.name}`}
          data-apple-device-menu={simulator.udid}
          className="-mr-1 -mt-1 h-6 w-6 shrink-0 p-0 text-muted-fg"
        >
          <DotsThree size={16} weight="bold" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="bottom" align="end" sideOffset={6}>
          <div className={MENU_LABEL_CLASS}>
            {size ? `${simulator.name} · ${size}` : simulator.name}
          </div>
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            onSelect={() => {
              void navigator.clipboard?.writeText(simulator.udid);
            }}
          >
            <Copy size={14} />
            Copy device id
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DangerConfirmMenuItem
            confirming={confirming}
            idleLabel="Delete simulator…"
            confirmLabel={size ? `Delete for good — frees ${size}` : "Delete for good"}
            idleDataAttribute={{ name: "data-apple-device-delete", value: simulator.udid }}
            confirmDataAttribute={{ name: "data-apple-device-delete-confirm", value: simulator.udid }}
            onBeginConfirm={() => setConfirming(true)}
            onConfirm={onDelete}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const FAMILY_GROUP_LABEL: Record<AppleLaneDeviceFamily, string> = {
  iphone: "iPhone",
  ipad: "iPad",
  watch: "Watch",
};

/**
 * Make a new device, at the foot of the page where the owner put it.
 *
 * A new device is EMPTY: it runs an installed runtime and copies nothing from
 * any other simulator, so it starts at a few megabytes and grows only with
 * what this lane installs. ADE deletes it, and all its data, when the lane is
 * archived or deleted. The runtime choice appears only when this Mac has more
 * than one; the model list is the one that runtime supports, newest first.
 */
/** The runtime menu's value for "the runtime this Xcode needs, not installed yet". */
const MISSING_RUNTIME_VALUE = "missing-runtime";

function CreateSection({
  runtimes,
  defaultSpec,
  missing,
  disabled,
  creating,
  onCreate,
  missingRuntime,
  install,
  onInstallAndCreate,
  onCancelInstall,
}: {
  runtimes: readonly AppleInstalledRuntime[];
  /** The service's default; the first runtime and its first iPhone when absent. */
  defaultSpec: AppleNewDeviceSpec | null;
  /** Set when the lane's registry row points at a simulator that is gone. */
  missing: AppleLaneDevice | null | undefined;
  disabled: boolean;
  creating: boolean;
  onCreate: (spec: AppleNewDeviceSpec) => void;
  /** Current models no installed runtime runs, offered as "Not installed". */
  missingRuntime: AppleMissingRuntime | null;
  install: AppleRuntimeInstallState | null;
  onInstallAndCreate?: (deviceType: string) => void;
  onCancelInstall?: () => void;
}) {
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const creatable = runtimes.filter((entry) => entry.deviceTypes.length > 0);
  const installing = appleRuntimeInstallActive(install);
  // No installed runtime at all: the missing one is the only choice.
  const pickedMissing = Boolean(missingRuntime) && (runtimeId === MISSING_RUNTIME_VALUE || creatable.length === 0);
  const runtime = pickedMissing
    ? null
    : creatable.find((entry) => entry.identifier === (runtimeId ?? defaultSpec?.runtime)) ?? creatable[0] ?? null;
  const types = pickedMissing ? missingRuntime!.deviceTypes : runtime?.deviceTypes ?? [];
  // The service's default model applies only to the service's default runtime.
  const wantedType = typeId ?? (runtime?.identifier === defaultSpec?.runtime ? defaultSpec?.deviceType : null);
  const deviceType = types.find((entry) => entry.identifier === wantedType)
    ?? types.find((entry) => entry.family === "iphone")
    ?? types[0]
    ?? null;
  const runtimeOptions: DrawerMenuOption<string>[] = [
    ...(missingRuntime
      ? [{ value: MISSING_RUNTIME_VALUE, label: `${missingRuntime.name} · Not installed` }]
      : []),
    ...creatable.map((entry) => ({ value: entry.identifier, label: entry.name })),
  ];
  const typeOptions: DrawerMenuOption<string>[] = types.map((entry) => ({
    value: entry.identifier,
    label: entry.name,
    group: FAMILY_GROUP_LABEL[entry.family],
  }));
  if (!runtime && !pickedMissing) return null;
  const runtimeValue = pickedMissing ? MISSING_RUNTIME_VALUE : runtime!.identifier;
  return (
    <section
      aria-label="Create a new one"
      data-apple-picker-section="Create a new one"
      className="flex min-w-0 flex-col gap-2 pt-1"
    >
      <h3 className="px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">
        Create a new one
      </h3>
      {missing ? (
        <p
          data-apple-lane-device-missing=""
          className="min-w-0 break-words px-0.5 font-sans text-[11px] leading-4 text-warning"
        >
          {`${missing.name} is registered to this lane but is not installed any more.`}
        </p>
      ) : null}
      <div className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {runtimeOptions.length > 1 ? (
            <DrawerMenu
              ariaLabel="Runtime"
              value={runtimeValue}
              placeholder="Runtime"
              options={runtimeOptions}
              disabled={disabled}
              onChange={(next) => {
                setRuntimeId(next);
                setTypeId(null);
              }}
            />
          ) : (
            <span data-apple-create-runtime="" className="shrink-0 font-sans text-[12px] leading-5 text-fg/80">
              {pickedMissing ? `${missingRuntime!.name} · Not installed` : runtime!.name}
            </span>
          )}
          <DrawerMenu
            ariaLabel="Device model"
            value={deviceType?.identifier ?? null}
            placeholder="Model"
            options={typeOptions}
            disabled={disabled}
            onChange={setTypeId}
            className="max-w-[14rem]"
          />
          <span className="min-w-0 flex-1" />
          <Button
            variant="primary"
            size="sm"
            disabled={disabled || !deviceType || (pickedMissing && (installing || !onInstallAndCreate))}
            aria-label={pickedMissing ? "Install the runtime and create a simulator" : "Create a new simulator for this lane"}
            onClick={() => {
              if (!deviceType) return;
              if (pickedMissing) onInstallAndCreate?.(deviceType.identifier);
              else onCreate({ runtime: runtime!.identifier, deviceType: deviceType.identifier });
            }}
            className="shrink-0"
          >
            {creating || (pickedMissing && installing) ? <AppleSpinner /> : null}
            {pickedMissing ? "Install & create" : "Create"}
          </Button>
        </div>
        {install && (installing || install.phase === "failed") ? (
          <AppleRuntimeInstallProgress install={install} onCancel={() => onCancelInstall?.()} />
        ) : (
          <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
            {pickedMissing
              ? `${missingRuntime!.name} isn't on this Mac. ADE downloads what Xcode needs (about 8 GB per runtime), then creates the simulator.`
              : "Starts empty. Nothing is copied or downloaded. Deleted with the lane."}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * What the simulators cost, and the one button that gets space back.
 *
 * "Clean up" runs the same pass ADE runs every 15 minutes: it deletes ADE
 * devices no lane holds (the "Leftover" cards) and powers off idle ADE devices.
 * It never deletes a simulator ADE did not make; an "Old ADE?" card is the
 * user's to delete from its own menu.
 */
function StorageSection({
  disk,
  measuringDisk,
  ownership,
  installedCount,
  cleaning,
  disabled,
  onCleanup,
}: {
  disk: AppleDeviceDiskUsage | null | undefined;
  measuringDisk: boolean;
  ownership: readonly AppleSimulatorOwnershipInfo[];
  installedCount: number;
  cleaning: boolean;
  disabled: boolean;
  onCleanup?: () => void;
}) {
  const total = appleDiskTotalLabel(disk);
  if (!total && !measuringDisk && !onCleanup) return null;
  const leftovers = ownership.filter((entry) => entry.ownership === "ade-orphan");
  const leftoverBytes = leftovers.reduce(
    (sum, entry) => sum + (disk?.devices.find((row) => row.udid === entry.udid)?.bytes ?? 0),
    0,
  );
  const leftoverLabel = leftovers.length && disk ? appleDiskLabel(leftoverBytes) : null;
  const unmarked = ownership.filter((entry) => entry.looksLikeAde).length;
  const summary = measuringDisk && !total
    ? "Measuring…"
    : [
      total ? `${installedCount} simulators use ${total}` : `${installedCount} simulators`,
      leftovers.length ? `${leftovers.length} leftover${leftoverLabel ? ` (${leftoverLabel})` : ""}` : null,
      unmarked ? `${unmarked} old ADE?` : null,
    ].filter(Boolean).join(" · ");
  return (
    <section
      aria-label="Storage"
      data-apple-picker-section="Storage"
      className="flex min-w-0 flex-col gap-2 pt-1"
    >
      <h3 className="px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">
        Storage
      </h3>
      <div className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <span data-apple-storage-summary="" className="min-w-0 flex-1 break-words font-sans text-[12px] leading-5 text-fg/85">
            {summary}
          </span>
          {onCleanup ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || cleaning}
              aria-label="Clean up ADE simulators"
              data-apple-storage-cleanup=""
              onClick={onCleanup}
              className="shrink-0"
            >
              {cleaning ? <AppleSpinner /> : null}
              Clean up
            </Button>
          ) : null}
        </div>
        <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
          Removes ADE's leftover devices and powers off idle ones. Your own simulators are never touched.
        </p>
      </div>
    </section>
  );
}

/** No simulators at all: where they come from, and the one button that helps. */
function EmptyCard({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <div
      data-apple-picker-empty=""
      className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col items-center gap-3 p-6 text-center"
    >
      <AppleLogo size={28} aria-hidden="true" className="text-muted-fg/60" />
      <p className="min-w-0 font-sans text-sm font-medium text-fg">
        No Apple simulators are installed.
      </p>
      <p className="min-w-0 max-w-xs font-sans text-xs leading-5 text-muted-fg">
        Install one in Xcode → Settings → Components. One runtime install then
        serves as many simulators as you care to make.
      </p>
      <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh} className="shrink-0">
        Refresh
      </Button>
    </div>
  );
}

/** Top right of the pane, where a refresh belongs. Icon only; it needs no word. */
function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <PaneTooltip label="Re-read installed simulators" side="bottom">
      <Button
        variant="ghost"
        size="sm"
        disabled={refreshing}
        aria-label="Refresh the simulator list"
        data-apple-picker-refresh=""
        onClick={onRefresh}
        className="h-6 w-6 shrink-0 p-0 text-muted-fg"
      >
        <ArrowsClockwise
          size={14}
          className={cn(refreshing && "animate-spin")}
        />
      </Button>
    </PaneTooltip>
  );
}
