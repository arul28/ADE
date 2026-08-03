import type { BrowserWindowConstructorOptions } from "electron";

export const ADE_WINDOWS_APP_USER_MODEL_ID = "com.ade.desktop";

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
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#0F0D14",
        symbolColor: "#F8F8F2",
        height: 32,
      },
    };
  }
  return {
    titleBarStyle: "default",
  };
}
