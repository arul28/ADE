import type { BrowserWindowConstructorOptions } from "electron";

export const ADE_WINDOWS_APP_USER_MODEL_ID = "com.ade.desktop";

/**
 * Windows caption-strip geometry and colour.
 *
 * macOS gets both of these for free: `hiddenInset` traffic lights are laid out
 * and recoloured by the OS against the window's own appearance. Windows does
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

/** ADE's header height in CSS px — mirrors `--shell-header-height` in index.css. */
export const WINDOWS_TITLE_BAR_OVERLAY_CSS_HEIGHT = 32;

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
    return WINDOWS_TITLE_BAR_OVERLAY_CSS_HEIGHT;
  }
  return Math.max(
    1,
    Math.round(WINDOWS_TITLE_BAR_OVERLAY_CSS_HEIGHT * zoomFactor),
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
      trafficLightPosition: { x: 12, y: 12 },
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
