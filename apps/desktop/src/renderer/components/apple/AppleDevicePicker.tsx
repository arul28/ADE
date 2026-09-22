import { useMemo, useState, type ReactNode } from "react";
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
  AppleDeviceIPadGlyph,
  AppleDeviceIPhoneGlyph,
  AppleDeviceTvGlyph,
  AppleDeviceVisionGlyph,
  AppleDeviceWatchGlyph,
  AppleLogo,
} from "../ui/appleIcons";
import {
  appleDeviceIdentity,
  appleDeviceModelLine,
  groupAppleSimulatorsByFamily,
  type AppleDeviceFamilyId,
} from "./appleDeviceFamily";
import { isAppleSimulatorBooted } from "./appleDeviceState";
import {
  appleDefaultTemplateUdid,
  appleDeviceDiskLabel,
  appleDiskLabel,
  appleInventorySummary,
  appleOwnerLaneLabel,
  partitionApplePickerDevices,
} from "./applePickerInventory";

/**
 * The pane's front door (§B2), rebuilt in round 5 to tell the truth.
 *
 * The page language is unchanged and deliberate: the tools grid's violet mesh,
 * its `.ade-tool-card` geometry, a device's MODEL alongside its name, a section
 * per family so an iPad is never filed under iPhone. What changed is what the
 * page CLAIMS.
 *
 * The owner opened it with five simulators installed and read four, because the
 * hero was lifted out of its family and so read as something other than one of
 * the five. Worse, that hero was not his lane's device at all — his lane had
 * none, so the picker heroed "the newest installed iPhone", a card that says
 * *your device* and is not. And it offered Open on a simulator another lane
 * owned, with nothing on screen to say so; the same blind spot made an agent
 * stop and ask him for permission instead of creating its own device.
 *
 * So, in order down the page:
 *
 * 1. ONE inventory line — the runtime by name, how many simulators share it,
 *    how many are running, and what the lot costs on disk. It names the runtime
 *    because one install serves any number of devices and nothing on screen
 *    used to say so.
 * 2. This lane's device, or a slot that says the lane has none and offers
 *    Create. Never a fallback hero.
 * 3. **Available** — installed, unowned, grouped by family, each Running or
 *    Stopped, under one line saying a stopped one only needs a boot.
 * 4. **In use elsewhere** — owned by another lane, NAMED, with no Open. Taking
 *    one over sits behind a confirmation that names the lane it interrupts.
 *
 * Start and Open remain the same single click — attach, boot, stream.
 */

export type AppleDevicePickerProps = {
  installed: readonly AppleInstalledSimulator[];
  /**
   * `deviceList().owners` — every lane's binding, this lane's flagged `mine`.
   *
   * Absent means "ownership unknown", which the page renders as everything
   * being free. That is the round-4 behaviour and it is only reachable from a
   * host too old to answer; the live payload always carries it.
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

function verbFor(simulator: AppleInstalledSimulator): "Open" | "Start" {
  return isAppleSimulatorBooted(simulator) ? "Open" : "Start";
}

/**
 * `iOS 26.2 · Stopped · 3.2 GB`.
 *
 * Disk joins the same line rather than taking one of its own: it is measured
 * lazily, and a line that appears from nowhere a second after the page paints
 * reflows the whole list under the cursor.
 */
function statusFor(
  simulator: AppleInstalledSimulator,
  disk: AppleDeviceDiskUsage | null | undefined,
): string {
  const running = isAppleSimulatorBooted(simulator) ? "Running" : "Stopped";
  const size = appleDeviceDiskLabel(disk, simulator.udid);
  return size ? `${simulator.runtime} · ${running} · ${size}` : `${simulator.runtime} · ${running}`;
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
  onRefresh,
  playing = true,
}: AppleDevicePickerProps) {
  const theme = useAppStore((s) => s.theme);
  const templates = useMemo(
    () => [...installed].sort((a, b) => a.name.localeCompare(b.name)),
    [installed],
  );

  const inventory = useMemo(() => appleInventorySummary(installed), [installed]);
  const partition = useMemo(
    () => partitionApplePickerDevices({ installed, owners, laneDevice }),
    [installed, laneDevice, owners],
  );

  /*
   * Grouped WITHIN the Available section, and the section is the whole of what
   * is available. Round 4 lifted its hero out of the family sections, so five
   * installed devices rendered as one card plus four — which is what the owner
   * counted. Nothing is lifted here: the lane's own device sits in its own
   * labelled slot because it is a different KIND of thing, and every other
   * installed device is inside a family group under a heading that counts.
   */
  const groups = useMemo(
    () => groupAppleSimulatorsByFamily(partition.available),
    [partition.available],
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
          <InventoryLine
            summary={inventory}
            disk={disk}
            measuring={measuringDisk}
          />

          <Section label="This lane's device" count={null}>
            {partition.mine ? (
              <HeroCard
                simulator={partition.mine}
                disk={disk}
                pending={pending === partition.mine.udid}
                disabled={busy}
                onStart={() => partition.mine && onStart(partition.mine.udid)}
              />
            ) : (
              <NoLaneDeviceCard
                missing={partition.laneDeviceMissing ? laneDevice : null}
                templates={templates}
                value={selectedSource}
                disabled={busy}
                creating={pending === "create"}
                onChange={setSource}
                onCreate={() => selectedSource && onCreate(selectedSource)}
              />
            )}
          </Section>

          {groups.length > 0 ? (
            <Section label="Available" count={partition.available.length}>
              <p
                data-apple-boot-hint=""
                className="min-w-0 px-0.5 font-sans text-[11px] leading-4 text-fg/70"
              >
                A stopped simulator only needs a boot — starting one takes a few
                seconds and downloads nothing.
              </p>
              {groups.map((group) => (
                <div
                  key={group.family}
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
                        disk={disk}
                        pending={pending === simulator.udid}
                        disabled={busy}
                        onStart={() => onStart(simulator.udid)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </Section>
          ) : null}

          {partition.elsewhere.length > 0 ? (
            <Section label="In use elsewhere" count={partition.elsewhere.length}>
              {partition.elsewhere.map((entry) => (
                <ElsewhereCard
                  key={entry.simulator.udid}
                  simulator={entry.simulator}
                  owner={entry.owner}
                  disk={disk}
                  pending={pending === entry.simulator.udid}
                  disabled={busy}
                  onTakeOver={() => onStart(entry.simulator.udid)}
                />
              ))}
            </Section>
          ) : null}

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-0.5">
            <p className="min-w-0 font-sans text-[11px] leading-4 text-muted-fg">
              Only simulators already installed appear here.
            </p>
            <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
          </div>
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
          className="relative m-auto flex w-full min-w-0 flex-col gap-4 px-5 py-6"
          style={{ maxWidth: COLUMN_MAX_PX }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** One labelled group of the page, with its own count where a count helps. */
function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number | null;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-apple-picker-section={label}
      className="flex min-w-0 flex-col gap-2"
    >
      <h3 className="flex min-w-0 items-center gap-1.5 px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">
        <span className="min-w-0">{label}</span>
        {count === null ? null : (
          <span data-apple-section-count="" className="shrink-0 font-normal normal-case tracking-normal text-fg/60">
            {count}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

/**
 * The one line at the top of the page.
 *
 * `iOS 26.3 · 5 simulators installed · 2 running`, then the disk total and the
 * sentence the owner did not know. Solid rather than the picker's 82% card:
 * this is the page's statement of fact, not one of the things you are choosing
 * between, and it never lifts under the cursor because it is not a target.
 */
function InventoryLine({
  summary,
  disk,
  measuring,
}: {
  summary: ReturnType<typeof appleInventorySummary>;
  disk: AppleDeviceDiskUsage | null | undefined;
  measuring: boolean;
}) {
  const total = appleDiskLabel(disk?.totalBytes);
  return (
    <div
      data-apple-inventory=""
      className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-1 p-3"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p
          data-apple-inventory-line=""
          className="min-w-0 break-words font-sans text-[12px] font-medium leading-4 text-fg"
        >
          {summary.text}
        </p>
        {total ? (
          <p
            data-apple-inventory-disk=""
            className="min-w-0 shrink-0 font-sans text-[12px] leading-4 text-muted-fg"
          >
            {`${total} of device data`}
          </p>
        ) : measuring ? (
          <p
            data-apple-inventory-disk="measuring"
            className="min-w-0 shrink-0 font-sans text-[12px] leading-4 text-muted-fg"
          >
            Measuring disk…
          </p>
        ) : null}
      </div>
      <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
        One runtime install serves any number of simulators — adding a device
        costs disk, never another download.
      </p>
    </div>
  );
}

/**
 * This lane's device, at twice the size of the rest, with one primary button.
 *
 * Reached ONLY when the lane really owns the simulator on it. There is no
 * fallback: a card of this weight saying *your device* about a device the lane
 * does not own is the round-5 defect, and the cure is that this component is
 * unreachable without an owned udid.
 */
function HeroCard({
  simulator,
  disk,
  pending,
  disabled,
  onStart,
}: {
  simulator: AppleInstalledSimulator;
  disk: AppleDeviceDiskUsage | null | undefined;
  pending: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  const identity = appleDeviceIdentity(simulator);
  const Glyph = FAMILY_GLYPH[identity.family];
  const verb = verbFor(simulator);
  return (
    <div
      data-apple-hero-card={simulator.udid}
      className="ade-tool-card flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 p-4"
    >
      <Glyph size={44} aria-hidden="true" className="shrink-0 text-fg/70" />
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <p className="min-w-0 break-words font-sans text-[15px] font-medium leading-5 text-fg">
          {simulator.name}
        </p>
        {identity.renamed && identity.model ? (
          <p className="min-w-0 break-words font-sans text-[12px] leading-4 text-fg/70">
            {identity.model}
          </p>
        ) : null}
        <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
          {statusFor(simulator, disk)}
        </p>
      </div>
      <Button
        variant="primary"
        size="sm"
        disabled={disabled}
        aria-label={`${verb} ${simulator.name}`}
        onClick={onStart}
        className="shrink-0"
      >
        {pending ? <Spinner /> : null}
        {verb}
      </Button>
    </div>
  );
}

/**
 * The lane owns nothing — said plainly, with the one button that fixes it.
 *
 * This slot is where round 4 put a device belonging to nobody in particular.
 * It now says which it is, and the create control it used to hold at the foot
 * of the page lives here, because "this lane has no device" and "make one" are
 * one thought.
 */
function NoLaneDeviceCard({
  missing,
  templates,
  value,
  disabled,
  creating,
  onChange,
  onCreate,
}: {
  /** Set when the lane's registry row points at a simulator that is gone. */
  missing: AppleLaneDevice | null | undefined;
  templates: readonly AppleInstalledSimulator[];
  value: string;
  disabled: boolean;
  creating: boolean;
  onChange: (udid: string) => void;
  onCreate: () => void;
}) {
  return (
    <div
      data-apple-no-lane-device=""
      className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-2 p-4"
    >
      <p className="min-w-0 break-words font-sans text-[13px] font-medium leading-5 text-fg">
        {missing
          ? `${missing.name} is registered to this lane but is not installed any more.`
          : "This lane has no Apple device yet."}
      </p>
      <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
        {missing
          ? "Create a fresh one, or start any available device below to bind it to this lane."
          : "Create one of its own, or start any available device below to bind it to this lane."}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2 pt-0.5">
        <label className="sr-only" htmlFor="apple-picker-source">
          Device to copy
        </label>
        <select
          id="apple-picker-source"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "h-7 min-w-0 flex-1 basis-40 rounded-md border border-border bg-surface px-2",
            "font-sans text-[11px] text-fg disabled:opacity-50",
          )}
        >
          {templates.map((entry) => (
            <option key={entry.udid} value={entry.udid}>
              {`${appleDeviceModelLine(entry)} · ${entry.runtime}`}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
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
  );
}

/** One available device. The whole card is the button — one click, one device. */
function DeviceCard({
  simulator,
  family,
  disk,
  pending,
  disabled,
  onStart,
}: {
  simulator: AppleInstalledSimulator;
  family: AppleDeviceFamilyId;
  disk: AppleDeviceDiskUsage | null | undefined;
  pending: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  const identity = appleDeviceIdentity(simulator);
  const Glyph = FAMILY_GLYPH[family];
  const verb = verbFor(simulator);
  return (
    <PaneTooltip label={appleDeviceModelLine(simulator)} side="bottom" className="min-w-0">
      <button
        type="button"
        disabled={disabled}
        aria-label={`${verb} ${simulator.name}`}
        data-apple-device-card={simulator.udid}
        onClick={onStart}
        className={cn(
          "ade-tool-card group flex w-full min-w-0 flex-col items-start gap-1 p-3 text-left",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <Glyph
            size={16}
            aria-hidden="true"
            className="shrink-0 text-muted-fg transition-colors duration-[160ms] ease-out group-hover:text-accent"
          />
          <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg">
            {simulator.name}
          </span>
          {pending ? <Spinner /> : (
            <span className="shrink-0 font-sans text-[11px] leading-4 text-muted-fg">{verb}</span>
          )}
        </span>
        {identity.renamed && identity.model ? (
          <span
            data-apple-model-line=""
            className="min-w-0 break-words font-sans text-[11px] leading-4 text-fg/70"
          >
            {identity.model}
          </span>
        ) : null}
        <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
          {statusFor(simulator, disk)}
        </span>
      </button>
    </PaneTooltip>
  );
}

/**
 * A device another lane is driving.
 *
 * Never a target. It carries the owning lane's NAME, it has no Open and no
 * Start, and it is not a button — which is the fix for the picker that offered
 * the owner "Open" on a simulator lane `dca9f144` was mid-test in. Taking it
 * over is possible, because two lanes wanting one device is a real situation
 * and refusing outright would leave the user in Xcode; but it costs a second
 * click behind a sentence that names the lane it interrupts.
 *
 * What the confirmation promises is what `laneDeviceRegistry.deviceAttach`
 * does: the binding MOVES. The losing lane's row is re-keyed to this lane in
 * one statement and its stream and session are released first, so the two
 * lanes never both own the device — and the simulator is left running, because
 * the lane taking it over is about to stream that same device.
 */
function ElsewhereCard({
  simulator,
  owner,
  disk,
  pending,
  disabled,
  onTakeOver,
}: {
  simulator: AppleInstalledSimulator;
  owner: AppleSimulatorOwner;
  disk: AppleDeviceDiskUsage | null | undefined;
  pending: boolean;
  disabled: boolean;
  onTakeOver: () => void;
}) {
  const identity = appleDeviceIdentity(simulator);
  const Glyph = FAMILY_GLYPH[identity.family];
  const [confirming, setConfirming] = useState(false);
  const laneLabel = appleOwnerLaneLabel(owner);
  return (
    <div
      data-apple-elsewhere-card={simulator.udid}
      className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-2 p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Glyph size={16} aria-hidden="true" className="shrink-0 text-muted-fg" />
        <span className="min-w-0 flex-1 basis-32 break-words font-sans text-[13px] font-medium leading-5 text-fg">
          {simulator.name}
        </span>
        <span
          data-apple-owner-lane={owner.laneId}
          className="min-w-0 shrink-0 font-sans text-[11px] leading-4 text-warning"
        >
          {`In use by ${laneLabel}`}
        </span>
      </div>
      {identity.renamed && identity.model ? (
        <span
          data-apple-model-line=""
          className="min-w-0 break-words font-sans text-[11px] leading-4 text-fg/70"
        >
          {identity.model}
        </span>
      ) : null}
      <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
        {statusFor(simulator, disk)}
      </span>
      {confirming ? (
        <div data-apple-takeover-confirm="" className="flex min-w-0 flex-col gap-2 pt-0.5">
          <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-fg">
            {`Take ${simulator.name} from ${laneLabel}? That lane loses the device and its live view — the simulator itself keeps running.`}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => setConfirming(false)}
              className="shrink-0"
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label={`Take ${simulator.name} from ${laneLabel}`}
              onClick={onTakeOver}
              className="shrink-0"
            >
              {pending ? <Spinner /> : null}
              Take over
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 pt-0.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Take over ${simulator.name}`}
            onClick={() => setConfirming(true)}
            className="shrink-0"
          >
            Take over…
          </Button>
        </div>
      )}
    </div>
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
      <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
    </div>
  );
}

function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={refreshing}
      onClick={onRefresh}
      className="shrink-0"
    >
      Refresh
    </Button>
  );
}
