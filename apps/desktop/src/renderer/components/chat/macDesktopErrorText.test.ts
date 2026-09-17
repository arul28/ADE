import { describe, expect, it } from "vitest";

import { macDesktopErrorText } from "./macDesktopErrorText";

describe("macDesktopErrorText", () => {
  it("drops the service's MAC_DESKTOP_ code prefix", () => {
    expect(macDesktopErrorText("MAC_DESKTOP_NO_DISPLAY: Lane abc has no Mac Desktop display."))
      .toBe("Lane abc has no Mac Desktop display.");
  });

  it("drops a driver code prefix that arrives lowercase", () => {
    expect(
      macDesktopErrorText("window_not_ready: Window 32734 has not published an accessibility element yet."),
    ).toBe("Window 32734 has not published an accessibility element yet.");
  });

  it("peels Electron's IPC wrapper off a claim failure", () => {
    expect(
      macDesktopErrorText(
        "Error invoking remote method 'ade.localRuntime.callAction': Error: window_not_ready: Window 1 is not ready.",
      ),
    ).toBe("Window 1 is not ready.");
  });

  it("leaves an ordinary sentence alone", () => {
    expect(macDesktopErrorText("The live view returned no address.")).toBe(
      "The live view returned no address.",
    );
  });

  it("does not eat a colon that is part of the sentence", () => {
    expect(macDesktopErrorText("Could not reach 127.0.0.1:62474 for the stream.")).toBe(
      "Could not reach 127.0.0.1:62474 for the stream.",
    );
  });

  it("does not mistake a single lowercase word for a code", () => {
    expect(macDesktopErrorText("note: the display is virtual")).toBe("note: the display is virtual");
  });

  it("answers null for nothing", () => {
    expect(macDesktopErrorText(null)).toBeNull();
    expect(macDesktopErrorText("   ")).toBeNull();
    expect(macDesktopErrorText("MAC_DESKTOP_NO_DISPLAY:   ")).toBeNull();
  });
});
