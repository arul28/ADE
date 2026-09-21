import { useMemo, useState, type ReactNode } from "react";
import type { Icon } from "@phosphor-icons/react";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
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

/**
 * The pane's front door (§B2).
 *
 * Round 2 shipped a flat black list under the heading "iOS Simulators" — a
 * different page language from the tools grid it opens out of, and a row that
 * said nothing about what "ADE Repro" actually was. This is the same page as
 * the tools grid: the violet mesh behind, `.ade-tool-card` cards on top, one
 * hero for the device you are most likely to want, then a section per family
 * so an iPad is never filed under iPhone, and every card carries its MODEL as
 * well as its name.
 *
 * Start and Open remain the same single click — attach, boot, stream.
 */

export type AppleDevicePickerProps = {
  installed: readonly AppleInstalledSimulator[];
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

function statusFor(simulator: AppleInstalledSimulator): string {
  return `${simulator.runtime} · ${isAppleSimulatorBooted(simulator) ? "Running" : "Stopped"}`;
}

export function AppleDevicePicker({
  installed,
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

  /**
   * The hero: this lane's own template if it has one, else the newest iPhone —
   * "newest" being the highest runtime string, which is what `iOS 26.2`
   * compares as anyway.
   */
  const hero = useMemo(() => {
    if (lastUsedUdid) {
      const remembered = installed.find((entry) => entry.udid === lastUsedUdid);
      if (remembered) return remembered;
    }
    const iphones = installed.filter((entry) => appleDeviceIdentity(entry).family === "iphone");
    const pool = iphones.length > 0 ? iphones : installed;
    return [...pool].sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }))[0]
      ?? null;
  }, [installed, lastUsedUdid]);

  /*
   * The hero is LIFTED out of its family, not copied above it. Two cards with
   * the same name and the same button on one page is the reader wondering
   * which of them is the real one — and a duplicate accessible name is a
   * picker no screen reader can describe.
   */
  const groups = useMemo(
    () => groupAppleSimulatorsByFamily(installed.filter((entry) => entry.udid !== hero?.udid)),
    [hero?.udid, installed],
  );

  const defaultTemplate = hero?.udid ?? "";
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
          {hero ? (
            <HeroCard
              simulator={hero}
              pending={pending === hero.udid}
              disabled={busy}
              onStart={() => onStart(hero.udid)}
            />
          ) : null}

          {groups.map((group) => (
            <section key={group.family} aria-label={group.label} data-apple-family={group.family} className="flex min-w-0 flex-col gap-2">
              <h3 className="px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">
                {group.label}
              </h3>
              <div
                className="grid min-w-0 gap-2"
                style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${CARD_MIN_TRACK_PX}px), 1fr))` }}
              >
                {group.devices.map((simulator) => (
                  <DeviceCard
                    key={simulator.udid}
                    simulator={simulator}
                    family={group.family}
                    pending={pending === simulator.udid}
                    disabled={busy}
                    onStart={() => onStart(simulator.udid)}
                  />
                ))}
              </div>
            </section>
          ))}

          <CreateCard
            templates={templates}
            value={selectedSource}
            disabled={busy}
            creating={pending === "create"}
            onChange={setSource}
            onCreate={() => selectedSource && onCreate(selectedSource)}
          />

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

/**
 * The one device the lane is most likely to want, at twice the size of the
 * rest, with one primary button. Wraps to a column below ~360px rather than
 * squeezing the button off the right edge.
 */
function HeroCard({
  simulator,
  pending,
  disabled,
  onStart,
}: {
  simulator: AppleInstalledSimulator;
  pending: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  const identity = appleDeviceIdentity(simulator);
  const Glyph = FAMILY_GLYPH[identity.family];
  const verb = verbFor(simulator);
  return (
    <div
      data-apple-hero-card=""
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
        <p className="min-w-0 font-sans text-[11px] leading-4 text-muted-fg">{statusFor(simulator)}</p>
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

/** One family row's card. The whole card is the button — one click, one device. */
function DeviceCard({
  simulator,
  family,
  pending,
  disabled,
  onStart,
}: {
  simulator: AppleInstalledSimulator;
  family: AppleDeviceFamilyId;
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
          {statusFor(simulator)}
        </span>
      </button>
    </PaneTooltip>
  );
}

/** The last card: a device type and one verb. Never a row inside a list. */
function CreateCard({
  templates,
  value,
  disabled,
  creating,
  onChange,
  onCreate,
}: {
  templates: readonly AppleInstalledSimulator[];
  value: string;
  disabled: boolean;
  creating: boolean;
  onChange: (udid: string) => void;
  onCreate: () => void;
}) {
  return (
    <div data-apple-create-card="" className="ade-tool-card flex min-w-0 flex-col gap-2 p-4">
      <p className="min-w-0 font-sans text-[13px] font-medium leading-5 text-fg">
        New simulator for this lane
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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

/** No simulators at all: where they come from, and the one button that helps. */
function EmptyCard({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <div
      data-apple-picker-empty=""
      className="ade-tool-card flex min-w-0 flex-col items-center gap-3 p-6 text-center"
    >
      <AppleLogo size={28} aria-hidden="true" className="text-muted-fg/60" />
      <p className="min-w-0 font-sans text-sm font-medium text-fg">
        No Apple simulators are installed.
      </p>
      <p className="min-w-0 max-w-xs font-sans text-xs leading-5 text-muted-fg">
        Install one in Xcode → Settings → Components.
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
