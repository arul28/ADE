import { describe, expect, it } from "vitest";
import {
  ADE_WINDOWS_APP_USER_MODEL_ID,
  windowChromeOptions,
} from "./windowAppearance";

describe("windowAppearance", () => {
  it("keeps inset traffic lights on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 },
    });
  });

  it("uses a Windows title-bar overlay with native caption controls", () => {
    expect(windowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#0F0D14",
        symbolColor: "#F8F8F2",
        height: 32,
      },
    });
    expect(ADE_WINDOWS_APP_USER_MODEL_ID).toBe("com.ade.desktop");
  });

  it("uses the native title bar on other platforms", () => {
    expect(windowChromeOptions("linux")).toEqual({
      titleBarStyle: "default",
    });
  });
});
