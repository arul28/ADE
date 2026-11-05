import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, DeviceMobile, DeviceTablet, Watch } from "@phosphor-icons/react";
import {
  ANDROID_CATALOG_BRAND_NAMES,
  androidCatalogColor,
  androidCatalogScreenLine,
  resolveAndroidCatalogProfile,
  type AndroidCatalogBrand,
  type AndroidCatalogEntry,
} from "../../../shared/androidDeviceCatalog";
import type { AndroidHardwareProfile, AndroidSystemImage } from "../../../shared/types/androidEmulator";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { DRAWER_INPUT, DrawerMenu, type DrawerMenuOption } from "../ui/drawerPrimitives";
import { MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import type { AndroidBodySpec } from "./androidDeviceBody";
import {
  androidTileReducedMotion,
  cachedAndroidTileStill,
  renderAndroidTileStill,
  startAndroidTileTurn,
  type AndroidTileSpec,
} from "./androidTileRenderer";

/**
 * The picker's "New device" grid: one tile per catalog device, with its
 * still render, brand mark, name, screen line and colour dots. Only the tile
 * the pointer is on turns (one WebGL context for the whole grid, see
 * `androidTileRenderer.ts`). A click makes the device with the newest image
 * that fits it and boots it; ▾ opens the image and name choice.
 */

export const ANDROID_TILE_FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-accent)_60%,transparent)] focus-visible:ring-offset-0";

export type AndroidCatalogCreateOptions = {
  colorId: string;
  systemImage?: string | null;
  displayName?: string | null;
};

/** The installed images this entry can run: Wear OS for a watch, a phone image for the rest. */
export function androidCatalogImages(entry: Pick<AndroidCatalogEntry, "formFactor">, images: readonly AndroidSystemImage[]): AndroidSystemImage[] {
  const wear = entry.formFactor === "wear";
  return images
    .filter((image) => (wear ? /wear/iu.test(image.tag) : !/wear|tv|automotive|desktop/iu.test(image.tag)))
    .sort((a, b) => b.apiLevel - a.apiLevel || imageTagRank(b.tag) - imageTagRank(a.tag));
}

/** Play Store images first: they are what a user tests on. */
function imageTagRank(tag: string): number {
  if (tag.includes("playstore")) return 2;
  if (tag.includes("google")) return 1;
  return 0;
}

function imageLabel(image: AndroidSystemImage): string {
  const tag = image.tag.includes("playstore") ? "Google Play" : image.tag.includes("google") ? "Google APIs" : image.tag;
  return `API ${image.apiLevel} · ${tag} · ${image.abi}`;
}

/* ---------- brand marks ---------- */

/** Google's G (four colours), for Pixel tiles. */
function GoogleG({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** The maker's mark: Google's G, else the maker's name set as a text mark (no copied logo art). */
export function AndroidBrandMark({ brand }: { brand: AndroidCatalogBrand }) {
  const name = ANDROID_CATALOG_BRAND_NAMES[brand];
  if (brand === "google") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1" title={name}>
        <GoogleG size={11} />
        <span className="select-none font-sans text-[9.5px] font-medium leading-none text-fg/70">{name}</span>
      </span>
    );
  }
  return (
    <span
      title={name}
      className={cn(
        "shrink-0 select-none font-sans text-[8.5px] font-semibold uppercase leading-none text-fg/70",
        brand === "samsung" && "tracking-[0.18em]",
        brand === "oneplus" && "tracking-[0.02em] normal-case text-[9.5px]",
        brand === "nothing" && "font-mono tracking-[0.14em]",
      )}
    >
      {brand === "oneplus" ? "OnePlus" : name}
    </span>
  );
}

function FormGlyph({ formFactor, className }: { formFactor: string | null | undefined; className?: string }) {
  const Glyph = formFactor === "tablet" ? DeviceTablet : formFactor === "wear" ? Watch : DeviceMobile;
  return <Glyph size={22} aria-hidden="true" className={className} />;
}

/* ---------- pictures ---------- */

/**
 * A device picture from the shared tile renderer: the cached still, drawn
 * once, and (when `turn` is set and motion is allowed) the slow turn on a 2D
 * canvas over it. Falls back to the form-factor glyph while the still draws
 * or when WebGL is not there.
 */
export function AndroidDevicePicture({
  entry,
  profile = null,
  colorId,
  aspect,
  width,
  height,
  turn = false,
  className,
}: {
  entry: AndroidCatalogEntry | null;
  profile?: AndroidBodySpec["profile"];
  colorId: string | null;
  aspect: number;
  width: number;
  height: number;
  turn?: boolean;
  className?: string;
}) {
  const formFactor = entry?.formFactor ?? profile?.formFactor ?? null;
  const resolvedAspect = aspect > 0 && aspect <= 1 ? aspect : entry ? Math.min(entry.screen.widthPx, entry.screen.heightPx) / Math.max(entry.screen.widthPx, entry.screen.heightPx) : 9 / 20;
  const spec = useMemo<AndroidTileSpec>(
    () => ({ entry, profile, colorId, aspect: resolvedAspect, width, height }),
    // The profile's fields, not its object: a refreshed inventory makes a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry, colorId, resolvedAspect, width, height, profile?.formFactor, profile?.screenInches],
  );
  const [still, setStill] = useState<string | null>(() => cachedAndroidTileStill(spec));
  const [turning, setTurning] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let live = true;
    const cached = cachedAndroidTileStill(spec);
    setStill(cached);
    if (!cached) void renderAndroidTileStill(spec).then((url) => { if (live && url) setStill(url); });
    return () => { live = false; };
  }, [spec]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!turn || !canvas || androidTileReducedMotion()) return;
    let live = true;
    const stop = startAndroidTileTurn(canvas, spec, () => { if (live) setTurning(true); });
    return () => {
      live = false;
      stop();
      setTurning(false);
    };
  }, [spec, turn]);

  return (
    <span
      aria-hidden="true"
      className={cn("relative flex shrink-0 items-center justify-center", className)}
      style={{ width, height }}
    >
      {still ? (
        <img src={still} alt="" draggable={false} width={width} height={height} className={cn("h-full w-full object-contain", turning && "invisible")} />
      ) : (
        <FormGlyph formFactor={formFactor} className="text-muted-fg/50" />
      )}
      <canvas
        ref={canvasRef}
        className={cn("pointer-events-none absolute inset-0 h-full w-full", !turning && "invisible")}
      />
    </span>
  );
}

/* ---------- brand tile ---------- */

export type AndroidCatalogTileState =
  | { kind: "ready"; images: AndroidSystemImage[]; profileId: string; fallback: boolean; ade: boolean }
  /** No image fits: the click opens setup (or says what to install). */
  | { kind: "no-image"; reason: string }
  /** This SDK has no profile for it (old Command-line Tools). */
  | { kind: "no-profile"; reason: string };

export function androidCatalogTileState(
  entry: AndroidCatalogEntry,
  profileIds: ReadonlySet<string>,
  images: readonly AndroidSystemImage[],
): AndroidCatalogTileState {
  const profile = resolveAndroidCatalogProfile(entry, profileIds);
  if (!profile) {
    return { kind: "no-profile", reason: `This SDK has no ${entry.name} profile. Update the Android SDK Command-line Tools, then refresh.` };
  }
  const fitting = androidCatalogImages(entry, images);
  if (fitting.length === 0) {
    return {
      kind: "no-image",
      reason: entry.formFactor === "wear" ? "Install a Wear OS system image to make a watch." : "Install a phone system image to make this device.",
    };
  }
  return { kind: "ready", images: fitting, ...profile };
}

export function AndroidCatalogTile({
  entry,
  state,
  disabled,
  onCreate,
  onRequestSetup,
}: {
  entry: AndroidCatalogEntry;
  state: AndroidCatalogTileState;
  disabled: boolean;
  onCreate: (catalogId: string, options: AndroidCatalogCreateOptions) => void;
  onRequestSetup?: (() => void) | undefined;
}) {
  const [colorId, setColorId] = useState(entry.colors[0]?.id ?? "");
  const [hovered, setHovered] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const color = androidCatalogColor(entry, colorId);
  const canSetup = state.kind === "no-image" && Boolean(onRequestSetup);
  const blocked = disabled || (state.kind !== "ready" && !canSetup);
  const newest = state.kind === "ready" ? state.images[0] ?? null : null;
  const label = state.kind === "ready"
    ? `Create a ${entry.name} in ${color.name} for this lane and start it`
    : canSetup
      ? `Set up the Android SDK to make a ${entry.name}`
      : `${entry.name}: ${state.reason}`;

  const create = () => {
    if (state.kind === "ready") onCreate(entry.id, { colorId: color.id, systemImage: newest?.packageId ?? null });
    else if (canSetup) onRequestSetup?.();
  };

  return (
    <div
      data-android-catalog-tile={entry.id}
      data-android-catalog-state={state.kind}
      className={cn("ade-tool-card group relative flex min-w-0 flex-col", blocked && "opacity-55")}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        disabled={blocked}
        aria-label={label}
        title={state.kind === "ready" ? undefined : state.reason}
        data-android-catalog-create={entry.id}
        onClick={create}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className={cn(
          "flex min-w-0 flex-col items-stretch gap-1.5 rounded-[inherit] px-3 pb-1 pt-3 text-left",
          ANDROID_TILE_FOCUS_RING,
          blocked ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <span className="flex h-[112px] min-w-0 items-center justify-center">
          <AndroidDevicePicture
            entry={entry}
            colorId={color.id}
            aspect={0}
            width={entry.formFactor === "tablet" ? 132 : 96}
            height={112}
            turn={hovered && !blocked && !detailsOpen}
          />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex h-3 min-w-0 items-center">
            <AndroidBrandMark brand={entry.brand} />
          </span>
          <span className="min-w-0 truncate font-sans text-[13px] font-medium leading-5 text-fg" title={entry.name}>{entry.name}</span>
        </span>
        <span className="min-w-0 truncate font-sans text-[11px] leading-4 text-muted-fg">
          {state.kind === "ready" ? androidCatalogScreenLine(entry) : state.kind === "no-image" && canSetup ? "Set up to install an image" : state.reason}
        </span>
      </button>
      <div className="flex min-w-0 items-center gap-1 px-3 pb-2.5 pt-1">
        <div role="radiogroup" aria-label={`${entry.name} colour`} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {entry.colors.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={choice.id === color.id}
              aria-label={choice.name}
              title={choice.name}
              data-android-catalog-color={choice.id}
              onClick={() => setColorId(choice.id)}
              className={cn(
                "h-3.5 w-3.5 shrink-0 cursor-pointer rounded-full border border-fg/25",
                ANDROID_TILE_FOCUS_RING,
                choice.id === color.id && "ring-1 ring-fg/70 ring-offset-1 ring-offset-[var(--color-bg)]",
              )}
              style={{ background: `linear-gradient(135deg, ${choice.frame}, ${choice.body})` }}
            />
          ))}
        </div>
        {state.kind === "ready" ? (
          <CatalogDetails
            entry={entry}
            state={state}
            colorName={color.name}
            open={detailsOpen}
            disabled={disabled}
            onOpenChange={setDetailsOpen}
            onCreate={(options) => onCreate(entry.id, { colorId: color.id, ...options })}
          />
        ) : null}
      </div>
    </div>
  );
}

/** ▾: the image (newest by default), the shown name, and which profile it uses. */
function CatalogDetails({
  entry,
  state,
  colorName,
  open,
  disabled,
  onOpenChange,
  onCreate,
}: {
  entry: AndroidCatalogEntry;
  state: Extract<AndroidCatalogTileState, { kind: "ready" }>;
  colorName: string;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (options: { systemImage: string | null; displayName: string | null }) => void;
}) {
  const [image, setImage] = useState<string | null>(state.images[0]?.packageId ?? null);
  const [name, setName] = useState("");
  const options = useMemo<DrawerMenuOption<string>[]>(
    () => state.images.map((entryImage) => ({ value: entryImage.packageId, label: imageLabel(entryImage) })),
    [state.images],
  );
  const profileLine = state.ade
    ? `ADE profile ${state.profileId}, added to Android Studio's device list.`
    : state.fallback
      ? `This SDK has no newer profile: uses ${state.profileId}.`
      : `SDK profile ${state.profileId}.`;
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`${entry.name} options: image and name`}
          data-android-catalog-details={entry.id}
          className={cn("h-5 w-5 shrink-0 p-0 text-muted-fg", ANDROID_TILE_FOCUS_RING)}
        >
          <CaretDown size={12} weight="bold" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className={cn(MENU_SURFACE_CLASS, "z-[140] flex w-[18rem] max-w-[calc(100vw-16px)] flex-col gap-2 p-3")}
        >
          <span className="font-sans text-[12px] font-medium text-fg">{`${entry.name} · ${colorName}`}</span>
          <label className="flex flex-col gap-1">
            <span className="font-sans text-[10px] uppercase tracking-[0.08em] text-muted-fg">System image</span>
            <DrawerMenu ariaLabel="System image" value={image} placeholder="Newest" options={options} disabled={options.length === 0} onChange={setImage} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-sans text-[10px] uppercase tracking-[0.08em] text-muted-fg">Name</span>
            <input
              className={DRAWER_INPUT}
              value={name}
              placeholder={entry.name}
              maxLength={60}
              aria-label="Device name"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <p className="font-sans text-[11px] leading-4 text-muted-fg">{profileLine}</p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              data-android-catalog-details-create={entry.id}
              onClick={() => {
                onOpenChange(false);
                onCreate({ systemImage: image, displayName: name.trim() || null });
              }}
            >
              Create and start
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The brand grid itself, in the picker's card grid. */
export function AndroidCatalogGrid({
  entries,
  profiles,
  images,
  disabled,
  onCreate,
  onRequestSetup,
}: {
  entries: readonly AndroidCatalogEntry[];
  profiles: readonly AndroidHardwareProfile[];
  images: readonly AndroidSystemImage[];
  disabled: boolean;
  onCreate: (catalogId: string, options: AndroidCatalogCreateOptions) => void;
  onRequestSetup?: (() => void) | undefined;
}): ReactNode {
  const profileIds = useMemo(() => new Set(profiles.map((profile) => profile.id)), [profiles]);
  return (
    <div
      data-android-catalog-grid=""
      className="grid min-w-0 gap-2"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 148px), 1fr))" }}
    >
      {entries.map((entry) => (
        <AndroidCatalogTile
          key={entry.id}
          entry={entry}
          state={androidCatalogTileState(entry, profileIds, images)}
          disabled={disabled}
          onCreate={onCreate}
          onRequestSetup={onRequestSetup}
        />
      ))}
    </div>
  );
}
