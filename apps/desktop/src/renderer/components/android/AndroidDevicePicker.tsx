import { useMemo, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowsClockwise,
  Copy,
  DeviceMobile,
  DeviceTablet,
  DotsThree,
  SignOut,
  type Icon,
} from "@phosphor-icons/react";
import type {
  AndroidAvdListing,
  AndroidDeviceInventory,
  AndroidHardwareProfile,
  AndroidLaneDeviceStatus,
} from "../../../shared/types/androidEmulator";
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
import { AppleSpinner } from "../apple/AppleSpinner";
import { DangerConfirmMenuItem } from "../apple/DangerConfirmMenuItem";
import { DrawerMenu, type DrawerMenuOption } from "../apple/drawer/drawerPrimitives";
import {
  androidAvdLabel,
  androidAvdMenuActions,
  androidAvdSpecLine,
  androidProfileGroup,
  androidStockProfiles,
} from "./androidDeviceState";

/**
 * The Android pane's front door, in the Apple picker's place and classes:
 * "This lane", "On this machine" (every other AVD, with running / off / TAKEN
 * and a ⋯ menu), and "New device" (a short list of stock profiles, one click
 * to create and boot, plus "More…" with every profile).
 *
 * The brand grid with 3D tiles (plan §7.1, P1) takes the stock list's place in
 * `NewDeviceSection`; nothing else on the page moves when it does.
 */

export type AndroidDevicePickerProps = {
  laneId: string;
  lane: AndroidLaneDeviceStatus | null;
  inventory: AndroidDeviceInventory | null;
  /** True while the first inventory read has not answered. */
  loadingInventory: boolean;
  /** The AVD a start is in flight for, `"create"` while making one. */
  pending: string | null;
  refreshing: boolean;
  /** Close the picker and go back to the lane's device (start it when off). */
  onOpenLaneDevice: () => void;
  onAttach: (avdName: string) => void;
  onCreate: (profileId: string) => void;
  onRelease: () => void;
  onDelete: (avdName: string) => void;
  onRefresh: () => void;
  /** False pauses the backdrop's loop, as on the tools grid. */
  playing?: boolean;
};

const COLUMN_MAX_PX = 560;
const CARD_MIN_TRACK_PX = 188;

function profileGlyph(profile: AndroidHardwareProfile | null | undefined): Icon {
  return profile?.formFactor === "tablet" ? DeviceTablet : DeviceMobile;
}

export function AndroidDevicePicker({
  laneId,
  lane,
  inventory,
  loadingInventory,
  pending,
  refreshing,
  onOpenLaneDevice,
  onAttach,
  onCreate,
  onRelease,
  onDelete,
  onRefresh,
  playing = true,
}: AndroidDevicePickerProps) {
  const theme = useAppStore((s) => s.theme);
  const lanes = useAppStore((s) => s.lanes);
  const laneName = (id: string) => lanes.find((entry) => entry.id === id)?.name ?? id;
  const profiles = inventory?.profiles ?? [];
  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const laneAvdName = lane?.device?.avdName ?? null;
  const others = useMemo(
    () => (inventory?.avds ?? []).filter((avd) => avd.name !== laneAvdName),
    [inventory?.avds, laneAvdName],
  );
  const busy = pending !== null;
  const hasImage = (inventory?.images.length ?? 0) > 0;

  return (
    <PickerPage theme={theme} playing={playing}>
      <section aria-label="This lane" data-android-picker-section="This lane" className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <SectionHeading>This lane</SectionHeading>
          <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
        </div>
        {lane?.device ? (
          <LaneDeviceCard
            lane={lane}
            profile={lane.avd?.profileId ? profileById.get(lane.avd.profileId) ?? null : null}
            profiles={profiles}
            disabled={busy}
            onOpen={onOpenLaneDevice}
            onRelease={onRelease}
          />
        ) : (
          <p className="min-w-0 break-words px-0.5 font-sans text-[11px] leading-4 text-muted-fg">
            This lane has no Android device yet. Pick one below, or make a new one.
          </p>
        )}
      </section>

      <section aria-label="On this machine" data-android-picker-section="On this machine" className="flex min-w-0 flex-col gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">
          <span className="min-w-0">On this machine</span>
          <span data-android-machine-count="" className="shrink-0 font-normal normal-case tracking-normal text-fg/60">
            {others.length}
          </span>
        </h3>
        {loadingInventory && !inventory ? (
          <p className="px-0.5 font-sans text-[11px] leading-4 text-muted-fg">Reading this machine's devices…</p>
        ) : others.length === 0 ? (
          <p className="px-0.5 font-sans text-[11px] leading-4 text-muted-fg">No other Android devices on this machine.</p>
        ) : (
          <div
            className="grid min-w-0 gap-2"
            style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${CARD_MIN_TRACK_PX}px), 1fr))` }}
          >
            {others.map((avd) => (
              <AvdCard
                key={avd.name}
                avd={avd}
                laneId={laneId}
                takenByName={avd.heldByLaneId && avd.heldByLaneId !== laneId ? laneName(avd.heldByLaneId) : null}
                profile={avd.profileId ? profileById.get(avd.profileId) ?? null : null}
                profiles={profiles}
                pending={pending === avd.name}
                disabled={busy}
                onStart={() => onAttach(avd.name)}
                onRelease={onRelease}
                onDelete={() => onDelete(avd.name)}
              />
            ))}
          </div>
        )}
      </section>

      <NewDeviceSection
        profiles={profiles}
        hasImage={hasImage}
        loading={loadingInventory && !inventory}
        disabled={busy}
        creating={pending === "create"}
        onCreate={onCreate}
      />
    </PickerPage>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="min-w-0 px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">
      {children}
    </h3>
  );
}

/** The Apple picker's page: the tools grid's backdrop, its scroller and its column. */
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
    <div className="ade-pane-chrome relative h-full min-h-0 min-w-0" data-android-picker="">
      <WorkToolPickerBackdrop theme={theme} playing={playing} />
      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
        <div className="relative mx-auto flex w-full min-w-0 flex-col gap-4 px-5 py-6" style={{ maxWidth: COLUMN_MAX_PX }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function StateTag({ tone, children, tooltip }: { tone: "success" | "warning" | "muted" | "accent"; children: ReactNode; tooltip?: string }) {
  const tag = (
    <span
      className={cn(
        "shrink-0 font-sans text-[10px] font-medium uppercase tracking-[0.08em]",
        tone === "success" && "text-success",
        tone === "warning" && "text-warning",
        tone === "muted" && "text-muted-fg",
        tone === "accent" && "text-accent",
      )}
    >
      {children}
    </span>
  );
  return tooltip ? <PaneTooltip label={tooltip} side="bottom">{tag}</PaneTooltip> : tag;
}

function laneStateTag(state: AndroidLaneDeviceStatus["state"]): ReactNode {
  switch (state) {
    case "booted":
      return <StateTag tone="success">Running</StateTag>;
    case "starting":
      return <StateTag tone="accent">Starting</StateTag>;
    case "stopping":
      return <StateTag tone="muted">Stopping</StateTag>;
    case "crashed":
      return <StateTag tone="warning">Stopped</StateTag>;
    default:
      return <StateTag tone="muted">Off</StateTag>;
  }
}

function LaneDeviceCard({
  lane,
  profile,
  profiles,
  disabled,
  onOpen,
  onRelease,
}: {
  lane: AndroidLaneDeviceStatus;
  profile: AndroidHardwareProfile | null;
  profiles: readonly AndroidHardwareProfile[];
  disabled: boolean;
  onOpen: () => void;
  onRelease: () => void;
}) {
  const Glyph = profileGlyph(profile);
  const name = lane.avd ? androidAvdLabel(lane.avd) : lane.device?.avdName ?? "Android device";
  const spec = lane.avd ? androidAvdSpecLine(lane.avd, profiles) : "This AVD is not on this machine any more.";
  return (
    <div
      data-android-lane-card={lane.device?.avdName ?? ""}
      className={cn("ade-tool-card group relative flex min-w-0 items-start gap-2 p-3", disabled && "opacity-50")}
    >
      <button
        type="button"
        disabled={disabled || !lane.avd}
        aria-label={`Open ${name}`}
        onClick={onOpen}
        className={cn("flex min-w-0 flex-1 items-start gap-2 text-left", disabled ? "cursor-not-allowed" : "cursor-pointer")}
      >
        <Glyph size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-fg transition-colors duration-[160ms] ease-out group-hover:text-accent" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg">{name}</span>
            {laneStateTag(lane.state)}
          </span>
          <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">{spec}</span>
        </span>
      </button>
      <AvdMenu
        name={name}
        avdName={lane.device?.avdName ?? ""}
        sizeBytes={lane.avd?.sizeBytes ?? null}
        disabled={disabled}
        onRelease={onRelease}
      />
    </div>
  );
}

/**
 * One AVD on this machine. A free one is a button that attaches and boots it
 * for this lane; one another lane holds says TAKEN, carries no menu and does
 * not respond (the Apple rule: a held device is not a choice here).
 */
function AvdCard({
  avd,
  laneId,
  takenByName,
  profile,
  profiles,
  pending,
  disabled,
  onStart,
  onRelease,
  onDelete,
}: {
  avd: AndroidAvdListing;
  laneId: string;
  takenByName: string | null;
  profile: AndroidHardwareProfile | null;
  profiles: readonly AndroidHardwareProfile[];
  pending: boolean;
  disabled: boolean;
  onStart: () => void;
  onRelease: () => void;
  onDelete: () => void;
}) {
  const Glyph = profileGlyph(profile);
  const name = androidAvdLabel(avd);
  const spec = androidAvdSpecLine(avd, profiles);
  if (takenByName) {
    return (
      <div
        data-android-avd-card={avd.name}
        data-android-avd-taken=""
        className="ade-tool-card ade-tool-card-solid flex min-w-0 items-start gap-2 p-3"
      >
        <Glyph size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-fg/60" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg/60">{name}</span>
            <StateTag tone="warning" tooltip={`On hold by ${takenByName}`}>Taken</StateTag>
          </div>
          <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">{spec}</span>
        </div>
      </div>
    );
  }
  const actions = androidAvdMenuActions(avd, laneId);
  // A running AVD ADE did not start is the user's (Android Studio's) emulator.
  const runningElsewhere = Boolean(avd.running && !avd.running.startedByAde);
  return (
    <div
      data-android-avd-card={avd.name}
      className={cn("ade-tool-card group relative flex min-w-0 items-start gap-2 p-3", (disabled || runningElsewhere) && "opacity-50")}
    >
      <button
        type="button"
        disabled={disabled || runningElsewhere}
        aria-label={`Start ${name} for this lane`}
        data-android-avd-start={avd.name}
        onClick={onStart}
        className={cn("flex min-w-0 flex-1 items-start gap-2 text-left", disabled || runningElsewhere ? "cursor-not-allowed" : "cursor-pointer")}
      >
        <Glyph size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-fg transition-colors duration-[160ms] ease-out group-hover:text-accent" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg">{name}</span>
            {pending ? <AppleSpinner /> : runningElsewhere ? (
              <StateTag tone="muted" tooltip="Another app started this emulator. Stop it there to use it here.">In use</StateTag>
            ) : avd.running ? (
              <StateTag tone="success">Running</StateTag>
            ) : (
              <StateTag tone="muted">Off</StateTag>
            )}
          </span>
          <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
            {avd.madeForOtherLane ? `${spec} · ADE made, other lane` : avd.adeCreated ? `${spec} · ADE made` : spec}
          </span>
        </span>
      </button>
      <AvdMenu
        name={name}
        avdName={avd.name}
        sizeBytes={avd.sizeBytes}
        disabled={disabled}
        {...(actions.release ? { onRelease } : {})}
        {...(actions.delete ? { onDelete } : {})}
      />
    </div>
  );
}

function sizeLabel(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function AvdMenu({
  name,
  avdName,
  sizeBytes,
  disabled,
  onRelease,
  onDelete,
}: {
  name: string;
  avdName: string;
  sizeBytes: number | null;
  disabled: boolean;
  /** Give the AVD back from this lane; it stays installed. */
  onRelease?: () => void;
  /** Delete an ADE-made AVD no lane holds. */
  onDelete?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const size = sizeLabel(sizeBytes);
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (!open) setConfirming(false); }}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Manage ${name}`}
          data-android-avd-menu={avdName}
          className="-mr-1 -mt-1 h-6 w-6 shrink-0 p-0 text-muted-fg"
        >
          <DotsThree size={16} weight="bold" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="bottom" align="end" sideOffset={6}>
          <div className={MENU_LABEL_CLASS}>{size ? `${name} · ${size}` : name}</div>
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            onSelect={() => { void window.ade?.app?.writeClipboardText?.(avdName); }}
          >
            <Copy size={14} />
            Copy AVD name
          </DropdownMenu.Item>
          {onRelease ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onRelease} data-android-avd-release={avdName}>
              <SignOut size={14} />
              Release from this lane
            </DropdownMenu.Item>
          ) : null}
          {onDelete ? (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
              <DangerConfirmMenuItem
                confirming={confirming}
                idleLabel="Delete device…"
                confirmLabel={size ? `Delete for good — frees ${size}` : "Delete for good"}
                idleDataAttribute={{ name: "data-android-avd-delete", value: avdName }}
                confirmDataAttribute={{ name: "data-android-avd-delete-confirm", value: avdName }}
                onBeginConfirm={() => setConfirming(true)}
                onConfirm={onDelete}
              />
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Make a new AVD for this lane from a stock profile, with the newest installed
 * image, and boot it: one click. "More…" opens every profile the SDK has.
 */
function NewDeviceSection({
  profiles,
  hasImage,
  loading,
  disabled,
  creating,
  onCreate,
}: {
  profiles: readonly AndroidHardwareProfile[];
  hasImage: boolean;
  loading: boolean;
  disabled: boolean;
  creating: boolean;
  onCreate: (profileId: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreProfileId, setMoreProfileId] = useState<string | null>(null);
  const stock = useMemo(() => androidStockProfiles(profiles), [profiles]);
  const moreOptions = useMemo<DrawerMenuOption<string>[]>(
    () => profiles.map((profile) => ({ value: profile.id, label: profile.name, group: androidProfileGroup(profile) })),
    [profiles],
  );
  const moreProfile = profiles.find((profile) => profile.id === moreProfileId) ?? profiles.find((profile) => profile.id === "medium_phone") ?? profiles[0] ?? null;
  const createDisabled = disabled || !hasImage;
  return (
    <section aria-label="New device" data-android-picker-section="New device" className="flex min-w-0 flex-col gap-2 pt-1">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <SectionHeading>New device</SectionHeading>
        <span className="min-w-0 px-0.5 font-sans text-[11px] leading-4 text-muted-fg">Stock Android on every device</span>
      </div>
      {/* The brand grid (plan §7.1, P1) goes here, in place of the stock list. */}
      {loading ? (
        <p className="px-0.5 font-sans text-[11px] leading-4 text-muted-fg">Reading this SDK's hardware profiles…</p>
      ) : (
        <div
          data-android-stock-profiles=""
          className="grid min-w-0 gap-2"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${CARD_MIN_TRACK_PX}px), 1fr))` }}
        >
          {stock.map((choice) => {
            const Glyph = profileGlyph(choice.profile);
            const screen = choice.profile.screenInches ? `${choice.profile.screenInches.toFixed(1)}″` : null;
            return (
              <button
                key={choice.profile.id}
                type="button"
                disabled={createDisabled}
                data-android-create-profile={choice.profile.id}
                aria-label={`Create a ${choice.label.toLowerCase()} for this lane (${choice.profile.name})`}
                onClick={() => onCreate(choice.profile.id)}
                className={cn(
                  "ade-tool-card group flex min-w-0 items-start gap-2 p-3 text-left",
                  createDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                )}
              >
                <Glyph size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-fg transition-colors duration-[160ms] ease-out group-hover:text-accent" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="min-w-0 break-words font-sans text-[13px] font-medium leading-5 text-fg">{choice.label}</span>
                  <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
                    {[choice.profile.name, screen].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {!loading && !hasImage ? (
        <p data-android-no-image="" className="min-w-0 break-words px-0.5 font-sans text-[11px] leading-4 text-warning">
          No phone image is installed. Install one in Android Studio's SDK Manager, then refresh.
        </p>
      ) : null}
      {creating ? (
        <p className="flex min-w-0 items-center gap-2 px-0.5 font-sans text-[11px] leading-4 text-muted-fg">
          <AppleSpinner />
          Creating the device…
        </p>
      ) : null}
      {profiles.length > 0 ? (
        moreOpen ? (
          <div data-android-more-profiles="" className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-2 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <DrawerMenu
                ariaLabel="Hardware profile"
                value={moreProfile?.id ?? null}
                placeholder="Profile"
                options={moreOptions}
                disabled={disabled}
                onChange={setMoreProfileId}
                className="max-w-[16rem]"
              />
              <span className="min-w-0 flex-1" />
              <Button
                variant="primary"
                size="sm"
                disabled={createDisabled || !moreProfile}
                aria-label="Create a new Android device for this lane"
                onClick={() => { if (moreProfile) onCreate(moreProfile.id); }}
                className="shrink-0"
              >
                Create
              </Button>
            </div>
            <p className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">
              {`${profiles.length} profiles from this SDK. New devices use the newest installed image and are deleted with the lane.`}
            </p>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            data-android-more=""
            onClick={() => setMoreOpen(true)}
            className="self-start px-1 text-muted-fg"
          >
            More…
          </Button>
        )
      ) : null}
    </section>
  );
}

function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <PaneTooltip label="Re-read this machine's Android devices" side="bottom">
      <Button
        variant="ghost"
        size="sm"
        disabled={refreshing}
        aria-label="Refresh the Android device list"
        data-android-picker-refresh=""
        onClick={onRefresh}
        className="h-6 w-6 shrink-0 p-0 text-muted-fg"
      >
        <ArrowsClockwise size={14} className={cn(refreshing && "animate-spin")} />
      </Button>
    </PaneTooltip>
  );
}
