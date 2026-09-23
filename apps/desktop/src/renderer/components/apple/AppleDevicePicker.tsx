import { useMemo, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowsClockwise, Copy, DotsThree, Trash } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type {
  AppleDeviceDiskUsage,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
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
import {
  appleDefaultTemplateUdid,
  appleDeviceDiskLabel,
  appleOwnerLaneLabel,
  partitionApplePickerDevices,
} from "./applePickerInventory";

/**
 * The pane's front door, rebuilt in round 6 to the owner's own layout.
 *
 * Round 5 led with a summary box — the runtime, a count of simulators, a count
 * running, and a sentence explaining that one runtime serves many devices. The
 * owner read all of it and asked for it to go: he can see how many devices he
 * has by looking at them, and a paragraph at the top of a picker is a paragraph
 * between him and the thing he came to click. The same went for the two
 * captions under the headings and the line at the foot of the page.
 *
 * What is left is a list, and the page says what it knows in the list:
 *
 * 1. **Available**, and beside the word, one glyph per device he owns — three
 *    iPhones and two iPads read as three iPhones and two iPads at a glance,
 *    which is the counting the deleted box was doing in prose.
 * 2. A group per device family, so an iPad is never filed under iPhone.
 * 3. One card per device: its glyph, its name, its OS and its model, and a
 *    menu. The whole card starts it.
 * 4. A device another lane holds says TAKEN, has no menu and does not respond
 *    to a click. There is no Take over here any more; the owner asked for the
 *    panel not to offer a device that is on hold elsewhere, and the CLI keeps
 *    `--force` for the rare recovery.
 * 5. **Create a new one** at the foot: the installed devices a copy can be made
 *    from, each with what that copy costs, and one button.
 *
 * A refresh button sits at the top right of the pane, where a refresh belongs,
 * rather than in the page's last line.
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
  /** The udid a start is in flight for, or `"create"` while cloning. */
  pending: string | null;
  /** The project's last used template, when there is one. */
  lastUsedUdid: string | null;
  refreshing: boolean;
  onStart: (udid: string) => void;
  onCreate: (sourceUdid: string) => void;
  /** Delete one installed simulator. Only ever offered for a device no lane holds. */
  onDelete?: (udid: string) => void;
  onRefresh: () => void;
  /** False pauses the backdrop's loop, exactly as on the tools grid. */
  playing?: boolean;
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

const Spinner = () => (
  <span
    aria-hidden="true"
    data-apple-spinner=""
    className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
  />
);

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
  pending,
  lastUsedUdid,
  refreshing,
  onStart,
  onCreate,
  onDelete,
  onRefresh,
  playing = true,
}: AppleDevicePickerProps) {
  const theme = useAppStore((s) => s.theme);
  const templates = useMemo(
    () => [...installed].sort((a, b) => a.name.localeCompare(b.name)),
    [installed],
  );

  const partition = useMemo(
    () => partitionApplePickerDevices({ installed, owners, laneDevice }),
    [installed, laneDevice, owners],
  );

  /**
   * Every installed device, in one list, each carrying what it is TO THIS LANE.
   *
   * The page used to run a section per state, which split five simulators into
   * a hero, a group of four and a third section the owner had to scroll to.
   * Family is the only grouping now; state is a tag on the card. So the count
   * beside "Available" and the number of cards on the page are the same number,
   * which is what went wrong when he counted four and had five.
   */
  const entries = useMemo(() => {
    const takenBy = new Map(partition.elsewhere.map((entry) => [entry.simulator.udid, entry.owner]));
    return installed.map((simulator) => ({
      simulator,
      owner: takenBy.get(simulator.udid) ?? null,
      mine: partition.mine?.udid === simulator.udid,
    }));
  }, [installed, partition.elsewhere, partition.mine]);

  const groups = useMemo(
    () => groupAppleSimulatorsByFamily(entries.map((entry) => entry.simulator)),
    [entries],
  );
  const stateFor = useMemo(
    () => new Map(entries.map((entry) => [entry.simulator.udid, entry])),
    [entries],
  );

  const freeCount = partition.available.length;
  const cannotClone = useMemo(
    () => new Set(
      entries
        .filter((entry) => entry.owner || isAppleSimulatorBooted(entry.simulator))
        .map((entry) => entry.simulator.udid),
    ),
    [entries],
  );

  const defaultTemplate = useMemo(
    () => appleDefaultTemplateUdid({ installed, lastUsedUdid, owners }),
    [installed, lastUsedUdid, owners],
  );
  const [source, setSource] = useState<string | null>(null);
  const selectedSource = source && templates.some((entry) => entry.udid === source)
    ? source
    : defaultTemplate;

  const busy = pending !== null;

  return (
    <PickerPage theme={theme} playing={playing}>
      {installed.length === 0 ? (
        <EmptyCard refreshing={refreshing} onRefresh={onRefresh} />
      ) : (
        <>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <AvailableHeading entries={entries} freeCount={freeCount} />
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
                {group.devices.map((simulator) => {
                  const entry = stateFor.get(simulator.udid);
                  return (
                    <DeviceCard
                      key={simulator.udid}
                      simulator={simulator}
                      family={group.family}
                      owner={entry?.owner ?? null}
                      mine={entry?.mine ?? false}
                      disk={disk}
                      pending={pending === simulator.udid}
                      disabled={busy}
                      onStart={() => onStart(simulator.udid)}
                      {...(onDelete ? { onDelete: () => onDelete(simulator.udid) } : {})}
                    />
                  );
                })}
              </div>
            </section>
          ))}

          <CreateSection
            templates={templates}
            cannotClone={cannotClone}
            value={selectedSource}
            disk={disk}
            measuringDisk={measuringDisk}
            missing={partition.laneDeviceMissing ? laneDevice : null}
            disabled={busy}
            creating={pending === "create"}
            onChange={setSource}
            onCreate={() => selectedSource && onCreate(selectedSource)}
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
  entries,
  freeCount,
}: {
  entries: readonly { simulator: AppleInstalledSimulator; owner: AppleSimulatorOwner | null }[];
  freeCount: number;
}) {
  const byFamily = useMemo(
    () => groupAppleSimulatorsByFamily(entries.map((entry) => entry.simulator)),
    [entries],
  );
  const takenUdids = useMemo(
    () => new Set(entries.filter((entry) => entry.owner).map((entry) => entry.simulator.udid)),
    [entries],
  );
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
        {byFamily.map((group) => {
          const Glyph = FAMILY_GLYPH[group.family];
          return (
            <span key={group.family} className="flex shrink-0 items-center gap-0.5">
              {group.devices.map((simulator) => (
                <Glyph
                  key={simulator.udid}
                  size={15}
                  aria-hidden="true"
                  data-apple-glyph={takenUdids.has(simulator.udid) ? "taken" : "free"}
                  className={cn(
                    "shrink-0",
                    takenUdids.has(simulator.udid) ? "text-muted-fg/55" : "text-fg",
                  )}
                />
              ))}
            </span>
          );
        })}
      </span>
      <span className="sr-only">
        {`${entries.length} installed, ${freeCount} available`}
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
            {pending ? <Spinner /> : mine ? (
              <span className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-accent">
                Yours
              </span>
            ) : booted ? (
              <span className="shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-success">
                Running
              </span>
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
          {confirming ? (
            <DropdownMenu.Item
              className={cn(MENU_ITEM_CLASS, "text-[var(--color-error)]")}
              data-apple-device-delete-confirm={simulator.udid}
              onSelect={onDelete}
            >
              <Trash size={14} />
              {size ? `Delete for good — frees ${size}` : "Delete for good"}
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item
              className={cn(MENU_ITEM_CLASS, "text-[var(--color-error)]")}
              data-apple-device-delete={simulator.udid}
              onSelect={(event) => {
                // Keep the menu open: the confirmation is the same row, one
                // step further on, so the device being deleted never changes
                // between the two clicks.
                event.preventDefault();
                setConfirming(true);
              }}
            >
              <Trash size={14} />
              Delete simulator…
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Make another one, at the foot of the page where the owner put it.
 *
 * A row per installed device, each one a source a copy is made from, and each
 * one honest about the cost. `simctl clone` duplicates the source's data
 * directory, so a copy of a 3.2 GB device is about 3.2 GB — the runtime is NOT
 * downloaded again, and saying so next to a number is the only way that reads
 * as reassurance rather than as a bill. Before the disk read lands there is no
 * number to show, so the row says what is certain: nothing is downloaded.
 */
function CreateSection({
  templates,
  cannotClone,
  value,
  disk,
  measuringDisk,
  missing,
  disabled,
  creating,
  onChange,
  onCreate,
}: {
  templates: readonly AppleInstalledSimulator[];
  /** Udids no clone can be made from: booted, or held by another lane. */
  cannotClone: ReadonlySet<string>;
  value: string | null;
  disk: AppleDeviceDiskUsage | null | undefined;
  measuringDisk: boolean;
  /** Set when the lane's registry row points at a simulator that is gone. */
  missing: AppleLaneDevice | null | undefined;
  disabled: boolean;
  creating: boolean;
  onChange: (udid: string) => void;
  onCreate: () => void;
}) {
  /*
   * Only devices a clone can actually be made FROM.
   *
   * `simctl clone` fails on a booted device, and a device another lane holds is
   * not this panel's to copy. The list used to offer every installed device, so
   * the top row on the owner's machine was a booted simulator on hold
   * elsewhere — a source that could only ever fail.
   */
  const sources = templates.filter((entry) => !cannotClone.has(entry.udid));
  const costFor = (simulator: AppleInstalledSimulator): string => {
    const size = appleDeviceDiskLabel(disk, simulator.udid);
    if (size) return `${simulator.runtime} · copy costs about ${size}, no download`;
    if (measuringDisk) return `${simulator.runtime} · measuring…`;
    return `${simulator.runtime} · already installed, no download`;
  };
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
      <div className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-1 p-2">
        <div
          role="radiogroup"
          aria-label="Device to copy"
          className="flex min-w-0 flex-col"
        >
          {sources.map((simulator) => {
            const selected = simulator.udid === value;
            return (
              <button
                key={simulator.udid}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                data-apple-create-source={simulator.udid}
                onClick={() => onChange(simulator.udid)}
                className={cn(
                  "flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-left",
                  "transition-colors duration-[120ms] ease-out",
                  selected ? "bg-accent/12" : "hover:bg-white/[0.04]",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words font-sans text-[12px] leading-5",
                    selected ? "font-medium text-fg" : "text-fg/80",
                  )}
                >
                  {simulator.name}
                </span>
                <span className="min-w-0 shrink-0 font-sans text-[10px] leading-4 text-muted-fg">
                  {costFor(simulator)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 items-center justify-end pt-0.5">
          <Button
            variant="primary"
            size="sm"
            disabled={disabled || !value}
            aria-label="Create a new simulator for this lane"
            onClick={onCreate}
            className="shrink-0"
          >
            {creating ? <Spinner /> : null}
            Create
          </Button>
        </div>
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
