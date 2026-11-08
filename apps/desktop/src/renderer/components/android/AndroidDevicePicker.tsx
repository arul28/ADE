import { useCallback, useMemo, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CaretRight,
  Copy,
  DotsThree,
  Play,
  SignOut,
  Stop,
  Swap,
} from "@phosphor-icons/react";
import { ANDROID_DEVICE_CATALOG, androidCatalogEntryForAvd } from "../../../shared/androidDeviceCatalog";
import { formatAndroidBytes } from "../../../shared/androidFormat";
import type {
  AndroidAvdListing,
  AndroidDeviceInventory,
  AndroidHardwareProfile,
  AndroidLaneDeviceStatus,
  AndroidLaneExtraStatus,
} from "../../../shared/types/androidEmulator";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";
import { DEVICE_CARD_GRID_COLUMNS, DevicePickerPage, DevicePickerRefreshButton } from "../device/DevicePickerPage";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "../ui/paneMenuTokens";
import { Spinner } from "../ui/Spinner";
import { DangerConfirmMenuItem } from "../ui/DangerConfirmMenuItem";
import { DrawerMenu, type DrawerMenuOption } from "../ui/drawerPrimitives";
import {
  androidAvdLabel,
  androidAvdMenuActions,
  androidAvdSpecLine,
  androidProfileGroup,
  androidScreenAspect,
} from "./androidDeviceState";
import {
  AndroidCatalogGrid,
  AndroidDevicePicture,
  ANDROID_TILE_FOCUS_RING,
  type AndroidCatalogCreateOptions,
} from "./AndroidCatalogGrid";

/**
 * The Android pane's front door, in the Apple picker's place and classes:
 * "This lane" (its device, then its extra devices: start, stop, make one the
 * lane's device, remove), "On this machine" (every other AVD, with running / off / TAKEN
 * and a ⋯ menu), "New device" (the brand grid: one click to create and boot,
 * plus "More…" with every profile), and "Storage" (what the AVDs take on
 * disk, and Clean up), then "System images" (P3: `AndroidSystemImagesSection`).
 *
 * Every device picture comes from one shared WebGL context
 * (`androidTileRenderer.ts`): stills, cached, and a slow turn on the tile the
 * pointer is on.
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
  /** A brand-grid tile: create the catalog device in a colour and boot it. */
  onCreateCatalog: (catalogId: string, options: AndroidCatalogCreateOptions) => void;
  /** No image fits a tile: open SDK setup (the pane's setup card). */
  onRequestSetup?: () => void;
  /** Storage: read every AVD with its size on disk (slow: it walks the folders). */
  onReadSizes?: () => Promise<AndroidAvdListing[]>;
  /** Storage › Clean up: delete these ADE-made AVDs (each off and held by no lane). */
  onCleanUp?: (avdNames: string[]) => void;
  onRelease: () => void;
  onDelete: (avdName: string) => void;
  onRefresh: () => void;
  /** False pauses the backdrop's loop, as on the tools grid. */
  playing?: boolean;
  /** P3: the System images section, under Storage (the pane builds it with the lane's machine pin). */
  systemImages?: ReactNode;
  /** The extra device a start, stop, promote or remove is in flight for. */
  pendingExtra?: string | null;
  /** What the lane's extra devices' cards do, by AVD name. */
  extraActions: AndroidExtraDeviceActions;
};

/** The calls one extra device's card makes, by AVD name. */
export type AndroidExtraDeviceActions = {
  /** Make the extra the lane's device (and open it). */
  promote: (avdName: string) => void;
  start: (avdName: string) => void;
  stop: (avdName: string) => void;
  /** Stop the extra and delete it: ADE made it for this lane. */
  remove: (avdName: string) => void;
};

/** The small picture on a lane or machine card: the AVD's catalog body in its colour, else a body from its profile. */
function AvdPicture({ avd, profile, dim = false }: { avd: AndroidAvdListing | AndroidLaneDeviceStatus["avd"]; profile: AndroidHardwareProfile | null; dim?: boolean }) {
  const entry = androidCatalogEntryForAvd(avd);
  return (
    <AndroidDevicePicture
      entry={entry}
      profile={profile}
      colorId={avd?.colorId ?? null}
      aspect={androidScreenAspect(avd)}
      width={34}
      height={48}
      className={cn("-my-1.5 -ml-1", dim && "opacity-60")}
    />
  );
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
  onCreateCatalog,
  onRequestSetup,
  onReadSizes,
  onCleanUp,
  onRelease,
  onDelete,
  onRefresh,
  playing = true,
  systemImages,
  pendingExtra = null,
  extraActions,
}: AndroidDevicePickerProps) {
  const theme = useAppStore((s) => s.theme);
  const lanes = useAppStore((s) => s.lanes);
  const laneName = (id: string) => lanes.find((entry) => entry.id === id)?.name ?? id;
  // Keyed on the inventory's own array: `?? []` outside a memo is a new array each render.
  const inventoryProfiles = inventory?.profiles;
  const profiles = useMemo(() => inventoryProfiles ?? [], [inventoryProfiles]);
  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const laneAvdName = lane?.device?.avdName ?? null;
  const laneExtras = lane?.extras;
  const extras = useMemo(() => laneExtras ?? [], [laneExtras]);
  // The lane's extras are shown under "This lane", not as other AVDs on the machine.
  const extraNames = useMemo(() => new Set(extras.map((extra) => extra.device.avdName.toLowerCase())), [extras]);
  const others = useMemo(
    () => (inventory?.avds ?? []).filter((avd) => avd.name !== laneAvdName && !extraNames.has(avd.name.toLowerCase())),
    [inventory?.avds, laneAvdName, extraNames],
  );
  const busy = pending !== null || pendingExtra !== null;
  const inventoryImages = inventory?.images;
  const images = useMemo(() => inventoryImages ?? [], [inventoryImages]);
  const hasImage = images.length > 0;

  return (
    <DevicePickerPage tool="android" theme={theme} playing={playing}>
      <section aria-label="This lane" data-android-picker-section="This lane" className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <SectionHeading>This lane</SectionHeading>
          <DevicePickerRefreshButton
            tool="android"
            tooltip="Re-read this machine's Android devices"
            label="Refresh the Android device list"
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
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
            {extras.length > 0
              ? "This lane has no device of its own. Make one of its extra devices the lane's device, or pick one below."
              : "This lane has no Android device yet. Pick one below, or make a new one."}
          </p>
        )}
        {extras.length > 0 ? (
          <div data-android-picker-extras="" className="flex min-w-0 flex-col gap-2 pt-1">
            <h4 className="flex min-w-0 items-center gap-1.5 px-0.5 font-sans text-[11px] font-medium text-muted-fg">
              <span className="min-w-0">Extra devices</span>
              <span className="shrink-0 font-normal text-fg/60">{extras.length}</span>
            </h4>
            <div className="grid min-w-0 gap-2" style={{ gridTemplateColumns: DEVICE_CARD_GRID_COLUMNS }}>
              {extras.map((extra) => (
                <ExtraDeviceCard
                  key={extra.device.avdName}
                  extra={extra}
                  profile={extra.avd?.profileId ? profileById.get(extra.avd.profileId) ?? null : null}
                  profiles={profiles}
                  pending={pendingExtra === extra.device.avdName}
                  disabled={busy}
                  actions={extraActions}
                />
              ))}
            </div>
          </div>
        ) : null}
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
            style={{ gridTemplateColumns: DEVICE_CARD_GRID_COLUMNS }}
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
        images={images}
        hasImage={hasImage}
        loading={loadingInventory && !inventory}
        disabled={busy}
        creating={pending === "create"}
        onCreate={onCreate}
        onCreateCatalog={onCreateCatalog}
        onRequestSetup={onRequestSetup}
      />

      {onReadSizes && (inventory?.avds.length ?? 0) > 0 ? (
        <StorageSection
          laneId={laneId}
          avdCount={inventory?.avds.length ?? 0}
          disabled={busy}
          onReadSizes={onReadSizes}
          onCleanUp={onCleanUp}
        />
      ) : null}

      {systemImages}
    </DevicePickerPage>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="min-w-0 px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg">
      {children}
    </h3>
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
        className={cn("flex min-w-0 flex-1 items-start gap-2 rounded-[inherit] text-left", ANDROID_TILE_FOCUS_RING, disabled ? "cursor-not-allowed" : "cursor-pointer")}
      >
        <AvdPicture avd={lane.avd} profile={profile} />
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
  const name = androidAvdLabel(avd);
  const spec = androidAvdSpecLine(avd, profiles);
  if (takenByName) {
    return (
      <div
        data-android-avd-card={avd.name}
        data-android-avd-taken=""
        className="ade-tool-card ade-tool-card-solid flex min-w-0 items-start gap-2 p-3"
      >
        <AvdPicture avd={avd} profile={profile} dim />
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
        className={cn("flex min-w-0 flex-1 items-start gap-2 rounded-[inherit] text-left", ANDROID_TILE_FOCUS_RING, disabled || runningElsewhere ? "cursor-not-allowed" : "cursor-pointer")}
      >
        <AvdPicture avd={avd} profile={profile} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg">{name}</span>
            {pending ? <Spinner /> : runningElsewhere ? (
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

/**
 * One of the lane's extra devices. A click makes it the lane's device (and
 * opens it), as a click on a free AVD makes that one the lane's. The ⋯ menu
 * starts or stops it beside the lane's device, and removes it: ADE made it,
 * so removing deletes it.
 */
function ExtraDeviceCard({
  extra,
  profile,
  profiles,
  pending,
  disabled,
  actions,
}: {
  extra: AndroidLaneExtraStatus;
  profile: AndroidHardwareProfile | null;
  profiles: readonly AndroidHardwareProfile[];
  pending: boolean;
  disabled: boolean;
  actions: AndroidExtraDeviceActions;
}) {
  const avdName = extra.device.avdName;
  const name = extra.avd ? androidAvdLabel(extra.avd) : avdName;
  const spec = extra.avd ? androidAvdSpecLine(extra.avd, profiles) : "This AVD is not on this machine any more.";
  const running = extra.state === "booted" || extra.state === "starting";
  const promote = extra.avd ? () => actions.promote(avdName) : undefined;
  return (
    <div
      data-android-extra-card={avdName}
      className={cn("ade-tool-card group relative flex min-w-0 items-start gap-2 p-3", disabled && "opacity-50")}
    >
      <button
        type="button"
        disabled={disabled || !promote}
        aria-label={`Make ${name} this lane's device`}
        data-android-extra-promote={avdName}
        onClick={promote}
        className={cn("flex min-w-0 flex-1 items-start gap-2 rounded-[inherit] text-left", ANDROID_TILE_FOCUS_RING, disabled ? "cursor-not-allowed" : "cursor-pointer")}
      >
        <AvdPicture avd={extra.avd} profile={profile} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-sans text-[13px] font-medium leading-5 text-fg">{name}</span>
            {pending ? <Spinner /> : laneStateTag(extra.state)}
          </span>
          <span className="min-w-0 break-words font-sans text-[11px] leading-4 text-muted-fg">{`${spec} · Extra`}</span>
        </span>
      </button>
      <AvdMenu
        name={name}
        avdName={avdName}
        sizeBytes={null}
        disabled={disabled}
        kind="extra"
        {...(running ? { onStop: () => actions.stop(avdName) } : { onStart: () => actions.start(avdName) })}
        {...(promote ? { onPromote: promote } : {})}
        onDelete={() => actions.remove(avdName)}
      />
    </div>
  );
}

function sizeLabel(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  return formatAndroidBytes(bytes);
}

/**
 * Per kind of card: the menu label's suffix (null: the AVD's size on disk),
 * the words of its delete (an AVD on the machine is deleted, an extra is
 * removed and deleted), and the `data-android-*` attribute of each item.
 */
const AVD_MENU = {
  avd: {
    labelSuffix: null,
    deleteIdle: "Delete device…",
    deleteConfirm: (size: string | null) => (size ? `Delete for good — frees ${size}` : "Delete for good"),
    attributes: {
      menu: "data-android-avd-menu",
      stop: "data-android-avd-stop",
      start: "data-android-avd-start-item",
      promote: "data-android-avd-promote-item",
      release: "data-android-avd-release",
      delete: "data-android-avd-delete",
      deleteConfirm: "data-android-avd-delete-confirm",
    },
  },
  extra: {
    labelSuffix: "extra device",
    deleteIdle: "Remove from this lane…",
    deleteConfirm: () => "Remove and delete the device",
    attributes: {
      menu: "data-android-extra-menu",
      stop: "data-android-extra-stop",
      start: "data-android-extra-start",
      promote: "data-android-extra-promote-item",
      release: "data-android-extra-release",
      delete: "data-android-extra-remove",
      deleteConfirm: "data-android-extra-remove-confirm",
    },
  },
} as const;

/**
 * The ⋯ menu of one AVD card: an AVD on this machine or the lane's own
 * (`kind: "avd"`), or one of the lane's extra devices (`kind: "extra"`). Each
 * item shows only when its handler is given; its attribute (`AVD_MENU`)
 * names the AVD.
 */
function AvdMenu({
  name,
  avdName,
  sizeBytes,
  disabled,
  kind = "avd",
  onStart,
  onStop,
  onPromote,
  onRelease,
  onDelete,
}: {
  name: string;
  avdName: string;
  sizeBytes: number | null;
  disabled: boolean;
  kind?: "avd" | "extra";
  /** Boot it beside the lane's device (an extra). */
  onStart?: () => void;
  onStop?: () => void;
  /** Make it the lane's device (an extra). */
  onPromote?: () => void;
  /** Give the AVD back from this lane; it stays installed. */
  onRelease?: () => void;
  /** Delete an ADE-made AVD no lane holds, or remove (and delete) an extra. */
  onDelete?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const size = sizeLabel(sizeBytes);
  const menu = AVD_MENU[kind];
  const suffix = menu.labelSuffix ?? size;
  const hook = (item: keyof typeof menu.attributes) => ({ [menu.attributes[item]]: avdName });
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (!open) setConfirming(false); }}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Manage ${name}`}
          {...hook("menu")}
          className="-mr-1 -mt-1 h-6 w-6 shrink-0 p-0 text-muted-fg"
        >
          <DotsThree size={16} weight="bold" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="bottom" align="end" sideOffset={6}>
          <div className={MENU_LABEL_CLASS}>{suffix ? `${name} · ${suffix}` : name}</div>
          {onStop ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onStop} {...hook("stop")}>
              <Stop size={14} />
              Stop
            </DropdownMenu.Item>
          ) : null}
          {onStart ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onStart} {...hook("start")}>
              <Play size={14} />
              Start beside the lane's device
            </DropdownMenu.Item>
          ) : null}
          {onPromote ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onPromote} {...hook("promote")}>
              <Swap size={14} />
              Make this the lane's device
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            onSelect={() => { void window.ade?.app?.writeClipboardText?.(avdName); }}
          >
            <Copy size={14} />
            Copy AVD name
          </DropdownMenu.Item>
          {onRelease ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onRelease} {...hook("release")}>
              <SignOut size={14} />
              Release from this lane
            </DropdownMenu.Item>
          ) : null}
          {onDelete ? (
            <>
              <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
              <DangerConfirmMenuItem
                confirming={confirming}
                idleLabel={menu.deleteIdle}
                confirmLabel={menu.deleteConfirm(size)}
                idleDataAttribute={{ name: menu.attributes.delete, value: avdName }}
                confirmDataAttribute={{ name: menu.attributes.deleteConfirm, value: avdName }}
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
 * Make a new AVD for this lane: the brand grid (one click makes the device
 * with the newest image that fits it, in the colour picked, and boots it),
 * and "More…" with every profile the SDK has, on a procedural body.
 */
function NewDeviceSection({
  profiles,
  images,
  hasImage,
  loading,
  disabled,
  creating,
  onCreate,
  onCreateCatalog,
  onRequestSetup,
}: {
  profiles: readonly AndroidHardwareProfile[];
  images: AndroidDeviceInventory["images"];
  hasImage: boolean;
  loading: boolean;
  disabled: boolean;
  creating: boolean;
  onCreate: (profileId: string) => void;
  onCreateCatalog: (catalogId: string, options: AndroidCatalogCreateOptions) => void;
  onRequestSetup?: (() => void) | undefined;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreProfileId, setMoreProfileId] = useState<string | null>(null);
  const moreOptions = useMemo<DrawerMenuOption<string>[]>(
    () => profiles.map((profile) => ({ value: profile.id, label: profile.name, group: androidProfileGroup(profile) })),
    [profiles],
  );
  const moreProfile = profiles.find((profile) => profile.id === moreProfileId) ?? profiles.find((profile) => profile.id === "medium_phone") ?? profiles[0] ?? null;
  const createDisabled = disabled || !hasImage;
  const moreAspect = moreProfile?.widthPx && moreProfile.heightPx
    ? Math.min(moreProfile.widthPx, moreProfile.heightPx) / Math.max(moreProfile.widthPx, moreProfile.heightPx)
    : 0;
  return (
    <section aria-label="New device" data-android-picker-section="New device" className="flex min-w-0 flex-col gap-2 pt-1">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <SectionHeading>New device</SectionHeading>
        <span className="min-w-0 px-0.5 font-sans text-[11px] leading-4 text-muted-fg">Stock Android on every device</span>
      </div>
      {loading ? (
        <p className="px-0.5 font-sans text-[11px] leading-4 text-muted-fg">Reading this SDK's hardware profiles…</p>
      ) : (
        <AndroidCatalogGrid
          entries={ANDROID_DEVICE_CATALOG}
          profiles={profiles}
          images={images}
          disabled={disabled}
          onCreate={onCreateCatalog}
          onRequestSetup={onRequestSetup}
        />
      )}
      {!loading && profiles.length === 0 ? (
        <p data-android-no-profiles="" className="min-w-0 break-words px-0.5 font-sans text-[11px] leading-4 text-warning">
          This SDK has no hardware profiles. Install the Android SDK Command-line Tools (or Android Studio), then refresh.
        </p>
      ) : null}
      {!loading && !hasImage ? (
        <p data-android-no-image="" className="min-w-0 break-words px-0.5 font-sans text-[11px] leading-4 text-warning">
          {onRequestSetup ? "No system image is installed. Pick a device to set one up." : "No system image is installed. Install one in Android Studio's SDK Manager, then refresh."}
        </p>
      ) : null}
      {creating ? (
        <p className="flex min-w-0 items-center gap-2 px-0.5 font-sans text-[11px] leading-4 text-muted-fg">
          <Spinner />
          Creating the device…
        </p>
      ) : null}
      {profiles.length > 0 ? (
        moreOpen ? (
          <div data-android-more-profiles="" className="ade-tool-card ade-tool-card-solid flex min-w-0 items-center gap-3 p-3">
            <AndroidDevicePicture
              entry={null}
              profile={moreProfile}
              colorId={null}
              aspect={moreAspect}
              width={44}
              height={60}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
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

/**
 * Storage ▸: each AVD's size on disk (measured when opened, not on every
 * read) and Clean up, which deletes the AVDs ADE made that are off and held
 * by no lane. The user's own AVDs are listed but never deleted.
 */
function StorageSection({
  laneId,
  avdCount,
  disabled,
  onReadSizes,
  onCleanUp,
}: {
  laneId: string;
  avdCount: number;
  disabled: boolean;
  onReadSizes: () => Promise<AndroidAvdListing[]>;
  onCleanUp?: ((avdNames: string[]) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [avds, setAvds] = useState<AndroidAvdListing[] | null>(null);
  const [reading, setReading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const read = useCallback(() => {
    setReading(true);
    void onReadSizes()
      .then(setAvds)
      .catch(() => setAvds(null))
      .finally(() => setReading(false));
  }, [onReadSizes]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    setConfirming(false);
    if (next) read();
  };
  const removable = (avds ?? []).filter((avd) => androidAvdMenuActions(avd, laneId).delete);
  const total = (avds ?? []).reduce((sum, avd) => sum + (avd.sizeBytes ?? 0), 0);
  const freed = removable.reduce((sum, avd) => sum + (avd.sizeBytes ?? 0), 0);
  return (
    <section aria-label="Storage" data-android-picker-section="Storage" className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        data-android-storage-toggle=""
        onClick={toggle}
        className={cn(
          "flex min-w-0 items-center gap-1 self-start rounded-[6px] px-0.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-muted-fg hover:text-fg",
          ANDROID_TILE_FOCUS_RING,
        )}
      >
        <span>Storage</span>
        <CaretRight size={10} weight="bold" aria-hidden="true" className={cn("transition-transform duration-[160ms]", open && "rotate-90")} />
        {open && avds ? (
          <span className="pl-1 font-normal normal-case tracking-normal text-fg/60">{sizeLabel(total) ?? "—"}</span>
        ) : (
          <span className="pl-1 font-normal normal-case tracking-normal text-fg/60">{`${avdCount} AVD${avdCount === 1 ? "" : "s"}`}</span>
        )}
      </button>
      {open ? (
        <div data-android-storage="" className="ade-tool-card ade-tool-card-solid flex min-w-0 flex-col gap-1.5 p-3">
          {reading && !avds ? (
            <p className="flex items-center gap-2 font-sans text-[11px] leading-4 text-muted-fg"><Spinner />Measuring…</p>
          ) : !avds ? (
            <p className="font-sans text-[11px] leading-4 text-warning">Could not read the AVD sizes.</p>
          ) : (
            <>
              <ul className="flex min-w-0 flex-col gap-1">
                {avds.map((avd) => (
                  <li key={avd.name} data-android-storage-row={avd.name} className="flex min-w-0 items-baseline gap-2 font-sans text-[11px] leading-4">
                    <span className="min-w-0 flex-1 truncate text-fg/85">{androidAvdLabel(avd)}</span>
                    <span className="shrink-0 text-muted-fg">
                      {avd.adeCreated ? "ADE made" : "Yours"}
                      {avd.heldByLaneId ? " · in use" : avd.running ? " · running" : ""}
                    </span>
                    <span className="w-14 shrink-0 text-right tabular-nums text-fg/70">{sizeLabel(avd.sizeBytes) ?? "—"}</span>
                  </li>
                ))}
              </ul>
              {onCleanUp ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
                  <span className="min-w-0 flex-1 font-sans text-[11px] leading-4 text-muted-fg">
                    {removable.length > 0
                      ? `${removable.length} ADE-made device${removable.length === 1 ? "" : "s"} no lane uses.`
                      : "Nothing to clean up: every ADE-made device is in use or running."}
                  </span>
                  {removable.length > 0 ? (
                    <Button
                      variant={confirming ? "danger" : "outline"}
                      size="sm"
                      disabled={disabled}
                      data-android-storage-cleanup={confirming ? "confirm" : ""}
                      onClick={() => {
                        if (!confirming) {
                          setConfirming(true);
                          return;
                        }
                        setConfirming(false);
                        onCleanUp(removable.map((avd) => avd.name));
                        setAvds((current) => current?.filter((avd) => !removable.includes(avd)) ?? null);
                      }}
                    >
                      {confirming ? `Delete ${removable.length} — frees ${sizeLabel(freed) ?? "space"}` : "Clean up…"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
