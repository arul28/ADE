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

  describe("a brain with no mac_desktop domain", () => {
    const RAW = "Domain 'mac_desktop' is unavailable in this runtime.";

    it("names the machine and its version instead of the action domain", () => {
      expect(macDesktopErrorText(RAW, {
        machineName: "Mac Studio",
        machineVersion: "1.2.74",
      })).toBe("Mac Studio runs ADE 1.2.74, which has no Mac Desktop. Update ADE there.");
    });

    it("peels the IPC wrapper before recognizing it", () => {
      // The exact shape a pinned remote refusal arrives in: the remote client's
      // method prefix, then the JSON-RPC code, then Electron's IPC wrapper.
      expect(macDesktopErrorText(
        "Error invoking remote method 'ade.remoteRuntime.callAction': Error: "
          + "Remote ADE service method ade/actions/call failed (code -32602): "
          + RAW,
        { machineName: "Mac Studio", machineVersion: "1.2.74" },
      )).toBe("Mac Studio runs ADE 1.2.74, which has no Mac Desktop. Update ADE there.");
    });

    it("still says what to do when the version is not known", () => {
      expect(macDesktopErrorText(RAW, { machineName: "Mac Studio" }))
        .toBe("Mac Studio runs an ADE without Mac Desktop. Update ADE there.");
      // No caller-provided name at all degrades to a machine, never to the code.
      expect(macDesktopErrorText(RAW))
        .toBe("That machine runs an ADE without Mac Desktop. Update ADE there.");
    });

    it("leaves a different unavailable domain alone", () => {
      expect(macDesktopErrorText("Domain 'app_control' is unavailable in this runtime.", {
        machineName: "Mac Studio",
        machineVersion: "1.2.74",
      })).toBe("Domain 'app_control' is unavailable in this runtime.");
    });
  });

  describe("lane ids", () => {
    const LANE_ID = "ab829725-4f40-4c1f-8582-091b500dd26a";

    it("replaces the lane id with the lane name when one is known", () => {
      expect(macDesktopErrorText(`Lane ${LANE_ID} is not recording its desktop.`, {
        laneId: LANE_ID,
        laneName: "docs-fix",
      })).toBe("Lane docs-fix is not recording its desktop.");
    });

    it("drops the id and keeps the sentence when the name is unknown", () => {
      expect(macDesktopErrorText(`Lane ${LANE_ID} is not recording its desktop.`, {
        laneId: LANE_ID,
      })).toBe("This lane is not recording its desktop.");
    });

    it("replaces a bare id anywhere in the message", () => {
      expect(macDesktopErrorText(`Could not move a window on ${LANE_ID}.`, {
        laneId: LANE_ID,
        laneName: "docs-fix",
      })).toBe("Could not move a window on docs-fix.");
    });

    it("leaves the message alone when the caller does not name the lane", () => {
      expect(macDesktopErrorText(`Lane ${LANE_ID} is not recording its desktop.`))
        .toBe(`Lane ${LANE_ID} is not recording its desktop.`);
    });
  });
});
