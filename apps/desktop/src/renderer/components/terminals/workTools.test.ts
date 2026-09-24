import { describe, expect, it } from "vitest";
import { AppleLogo } from "../ui/appleIcons";
import { IOS_RUNTIME_UNSUPPORTED_REASON, isReadOnlyWorkTool, workToolAvailability, workToolCardLabel, workToolLabel, WORK_TOOL_DEFINITIONS, type WorkToolContext } from "./workTools";

const LOCAL_MAC: WorkToolContext = {
  supportsIosSimulator: true,
  isWebClient: false,
};

describe("Apple work tool labels", () => {
  const ios = WORK_TOOL_DEFINITIONS.find((entry) => entry.id === "ios");

  it("calls the tool Apple Development on the card, the tab and the palette", () => {
    // Round 3 §B1: one tool, one name, everywhere it is written — and the name
    // is the work, not the company.
    expect(ios?.label).toBe("Apple Development");
    expect(ios?.tabLabel).toBeUndefined();
    expect(ios?.tabTooltip).toBe("Apple simulators and previews");
    expect(ios?.hint).toBe("Open an Apple device");
    expect(workToolLabel("ios")).toBe("Apple Development");
    expect(workToolCardLabel("ios")).toBe("Apple Development");
  });

  it("wears the Apple mark rather than a generic phone", () => {
    // The glyph is ours (`ui/appleIcons`), not Phosphor's device family: every
    // other tool's icon is a Phosphor import, and "a phone" described the
    // browser's mobile emulation just as well as it described this.
    expect(ios?.icon).toBe(AppleLogo);
    expect((ios?.icon as { displayName?: string } | undefined)?.displayName).toBe("AppleLogo");
  });
});

describe("workToolAvailability Apple gate", () => {
  it("follows the bound runtime, not the viewer's OS", () => {
    expect(workToolAvailability("ios", LOCAL_MAC)).toEqual({ available: true, reason: null });
    expect(workToolAvailability("ios", { ...LOCAL_MAC, supportsIosSimulator: false })).toEqual({
      available: false,
      reason: IOS_RUNTIME_UNSUPPORTED_REASON,
    });
    expect(workToolAvailability("ios", {
      supportsIosSimulator: false,
      isWebClient: false,
    })).toEqual({
      available: false,
      reason: IOS_RUNTIME_UNSUPPORTED_REASON,
    });
  });

  it("keeps the hosted web client on the full Apple tool when the runtime is a Mac", () => {
    const webMac: WorkToolContext = {
      supportsIosSimulator: true,
      isWebClient: true,
    };
    expect(isReadOnlyWorkTool("ios", webMac)).toBe(false);
    expect(workToolAvailability("ios", webMac)).toEqual({ available: true, reason: null });
    expect(workToolAvailability("ios", { ...webMac, supportsIosSimulator: false })).toEqual({
      available: false,
      reason: IOS_RUNTIME_UNSUPPORTED_REASON,
    });
  });

  // Work tools follow the session's machine, so App Control is no longer gated
  // on the project tab's binding; the hosted web client still only watches it.
  it("keeps App Control read-only on the web and drivable everywhere else", () => {
    expect(workToolAvailability("app-control", LOCAL_MAC))
      .toEqual({ available: true, reason: null });
    expect(isReadOnlyWorkTool("app-control", { ...LOCAL_MAC, isWebClient: true })).toBe(true);
    expect(workToolAvailability("app-control", { ...LOCAL_MAC, isWebClient: true }))
      .toEqual({ available: true, reason: null });
  });
});

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
