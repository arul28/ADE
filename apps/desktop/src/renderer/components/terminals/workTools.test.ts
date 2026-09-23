import { describe, expect, it } from "vitest";
import { AppleLogo } from "../ui/appleIcons";
import {
  IOS_RUNTIME_UNSUPPORTED_REASON,
  isReadOnlyWorkTool,
  workToolAvailability,
  workToolCardLabel,
  workToolLabel,
  WORK_TOOL_DEFINITIONS,
  type WorkToolContext,
} from "./workTools";

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
