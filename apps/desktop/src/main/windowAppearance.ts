import type { BrowserWindowConstructorOptions } from "electron";

export const ADE_WINDOWS_APP_USER_MODEL_ID = "com.ade.desktop";

/**
 * Windows caption-strip geometry and colour.
 *
 * macOS gets the colour for free: the OS recolours `hiddenInset` traffic
 * lights against the window's own appearance. Their position does not follow
 * zoom, which `macTrafficLightPosition` below handles. Windows does
 * neither — `titleBarOverlay` is a literal rectangle ADE declares in DIP with a
 * hardcoded colour, and it stays exactly where it was put until
 * `setTitleBarOverlay` says otherwise. Two things move underneath it:
 *
 *  - **Zoom.** ADE's own header is `--shell-header-height: 32px`, in CSS px,
 *    which `webFrame.setZoomLevel` scales. At 70% zoom the header is ~26 DIP
 *    tall while a fixed 32 DIP caption strip keeps eating the first ~6 DIP of
 *    the tab strip below it, and clicks there go to the OS rather than to ADE.
 *  - **Theme.** The overlay is opaque, so a dark rectangle sits in the corner
 *    of a light header until it is repainted.
 *
 * Both are the same fix: recompute the overlay from the live zoom factor and
 * theme and push it down through `app.setTitleBarOverlay`. The horizontal axis
 * needs none of this — `renderer/lib/windowControlsOverlay.ts` reads the real
 * rect from the Window Controls Overlay API, which is already in CSS px.
 */

/** ADE's header height in CSS px — mirrors `--shell-header-height` in foundation.css. */
export const SHELL_HEADER_CSS_HEIGHT = 32;

export type WindowsTitleBarOverlayTheme = "dark" | "light";

export type WindowsTitleBarOverlay = {
  color: string;
  symbolColor: string;
  height: number;
};

/**
 * Opaque stand-ins for `--shell-header-bg` / `--shell-header-fg` per theme.
 * `titleBarOverlay` takes a flat colour, so the translucent header tokens are
 * flattened here rather than sampled: dark is the long-standing pair, light is
 * `color-mix(--color-surface-raised 90%, --color-bg)` over `--color-fg`.
 */
export const WINDOWS_TITLE_BAR_OVERLAY_COLORS: Readonly<
  Record<WindowsTitleBarOverlayTheme, { color: string; symbolColor: string }>
> = {
  dark: { color: "#0F0D14", symbolColor: "#F8F8F2" },
  light: { color: "#FEFEFE", symbolColor: "#1A1A1E" },
};

/**
 * Caption-strip height in DIP for a renderer zoom factor. The strip has to
 * cover exactly the rows the header occupies on screen, and the header is
 * measured in CSS px, so the DIP height is the CSS height times the zoom
 * factor. Electron rejects a non-positive height, so a nonsense factor falls
 * back to the unzoomed value rather than propagating.
 */
export function windowsTitleBarOverlayHeight(zoomFactor: number): number {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return SHELL_HEADER_CSS_HEIGHT;
  }
  return Math.max(
    1,
    Math.round(SHELL_HEADER_CSS_HEIGHT * zoomFactor),
  );
}

/** The full overlay descriptor for a theme and zoom factor. */
export function windowsTitleBarOverlay(args: {
  theme?: WindowsTitleBarOverlayTheme;
  zoomFactor?: number;
} = {}): WindowsTitleBarOverlay {
  const palette = WINDOWS_TITLE_BAR_OVERLAY_COLORS[args.theme ?? "dark"]
    ?? WINDOWS_TITLE_BAR_OVERLAY_COLORS.dark;
  return {
    color: palette.color,
    symbolColor: palette.symbolColor,
    height: windowsTitleBarOverlayHeight(args.zoomFactor ?? 1),
  };
}

/**
 * macOS traffic-light placement for a renderer zoom factor.
 *
 * The OS draws the lights at a fixed size, and nothing can scale them. ADE's
 * header is 32 CSS px, so on screen it is `32 × factor` DIP tall: ~26 DIP at
 * 70% zoom, ~51 DIP at 150%. A fixed `y` leaves the lights sitting low in a
 * short header and high in a tall one. Moving `y` with the header keeps their
 * centre on the header's centre at every zoom. `x` stays put: the logo's
 * clearance is already held constant in DIP (`shellHeaderInsetPx`).
 *
 * `y` is the top of the button row, whose centre sits 7 DIP below it (measured
 * on macOS 27: y=12 puts the centres at 19 DIP).
 */
const MAC_TRAFFIC_LIGHT_X = 12;
const MAC_TRAFFIC_LIGHT_HALF_HEIGHT_DIP = 7;
/** Display 100% renders at factor 1.1 (see `zoomFactorForDisplay`). */
const MAC_DEFAULT_ZOOM_FACTOR = 1.1;

export function macTrafficLightPosition(zoomFactor: number): { x: number; y: number } {
  const factor = Number.isFinite(zoomFactor) && zoomFactor > 0
    ? zoomFactor
    : MAC_DEFAULT_ZOOM_FACTOR;
  const headerCentreDip = (SHELL_HEADER_CSS_HEIGHT * factor) / 2;
  return {
    x: MAC_TRAFFIC_LIGHT_X,
    y: Math.max(0, Math.round(headerCentreDip - MAC_TRAFFIC_LIGHT_HALF_HEIGHT_DIP)),
  };
}

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"
>;

export function windowChromeOptions(
  platform: NodeJS.Platform,
): WindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      // Creation-time default; the renderer re-places the lights once it
      // knows the stored zoom.
      trafficLightPosition: macTrafficLightPosition(MAC_DEFAULT_ZOOM_FACTOR),
    };
  }
  if (platform === "win32") {
    // Creation-time defaults only: the window opens unzoomed on the dark theme
    // ADE paints to avoid a load flash. The renderer re-pushes both the moment
    // it knows the stored zoom and the persisted theme.
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: windowsTitleBarOverlay(),
    };
  }
  return {
    titleBarStyle: "default",
  };
}
