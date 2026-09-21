import { describe, expect, it } from "vitest";
import {
  WORK_TOOL_DEFINITIONS,
  isReadOnlyWorkTool,
  workToolAvailability,
  type WorkToolContext,
} from "./workTools";

/**
 * The Mac Desktop tab's availability rule, which is the one rule in this file
 * that is NOT about the machine the renderer is running on.
 */

const context = (overrides: Partial<WorkToolContext> = {}): WorkToolContext => ({
  supportsIosSimulator: false,
  isWebClient: false,
  ...overrides,
});

describe("Mac Desktop tool availability", () => {
  it("is in the catalogue", () => {
    expect(WORK_TOOL_DEFINITIONS.some((definition) => definition.id === "mac-desktop")).toBe(true);
  });

  it("hides the tab when the runtime host says it cannot host a display", () => {
    const availability = workToolAvailability("mac-desktop", context({ supportsMacDesktop: false }));
    expect(availability.available).toBe(false);
    // The reason names the HOST, because "macOS only" on a Mac watching a Linux
    // runtime reads as a bug in ADE rather than a fact about the lane.
    expect(availability.reason).toBe("This lane's host isn't a Mac");
  });

  it("shows the host's own reason when it has one, so a Mac with no driver is not called 'not a Mac'", () => {
    const availability = workToolAvailability("mac-desktop", context({
      supportsMacDesktop: false,
      macDesktopUnsupportedReason: "The native desktop driver is missing from this ADE installation. Reinstall or update ADE, then restart it.",
    }));
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("driver is missing");
  });

  it("shows the tab before the host has answered", () => {
    expect(workToolAvailability("mac-desktop", context()).available).toBe(true);
    expect(workToolAvailability("mac-desktop", context({ supportsMacDesktop: null })).available).toBe(true);
    expect(workToolAvailability("mac-desktop", context({ supportsMacDesktop: true })).available).toBe(true);
  });

  it("follows the session machine's host, so a remote tab never hides it", () => {
    // The one gate is the answer from the machine the FOCUSED CHAT runs on
    // (`useMacDesktopSupport`, cached per pin). There is deliberately no
    // tab-level flag in this context: "the project tab is bound remotely" is
    // not a fact about whether the lane's host is a Mac, and the same box can
    // be a Mac Desktop host for a Studio chat while this desktop is Windows.
    expect(workToolAvailability("ios", context()).available).toBe(false);
    expect(workToolAvailability("mac-desktop", context({ supportsMacDesktop: true })).available).toBe(true);
    // A non-Mac host hides it for every chat, remote or local.
    expect(workToolAvailability("mac-desktop", context({ supportsMacDesktop: false })).available).toBe(false);
  });

  it("is watchable but not drivable from the hosted web client", () => {
    expect(isReadOnlyWorkTool("mac-desktop", context({ isWebClient: true }))).toBe(true);
    expect(isReadOnlyWorkTool("mac-desktop", context())).toBe(false);
  });
});
