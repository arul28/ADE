import { describe, expect, it } from "vitest";
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
  isRemoteProject: false,
  supportsIosSimulator: true,
  isWebClient: false,
};

describe("Apple work tool labels", () => {
  const ios = WORK_TOOL_DEFINITIONS.find((entry) => entry.id === "ios");

  it("keeps the picker card named Simulator and the tab named Apple", () => {
    expect(ios?.label).toBe("Simulator");
    expect(ios?.tabLabel).toBe("Apple");
    expect(ios?.tabTooltip).toBe("Apple simulators and previews");
    expect(ios?.hint).toBe("Open an Apple device");
    expect(workToolLabel("ios")).toBe("Apple");
    expect(workToolCardLabel("ios")).toBe("Simulator");
  });
});

describe("workToolAvailability Apple gate", () => {
  it("follows the bound runtime, not project locality or the viewer's OS", () => {
    expect(workToolAvailability("ios", LOCAL_MAC)).toEqual({ available: true, reason: null });
    expect(workToolAvailability("ios", { ...LOCAL_MAC, isRemoteProject: true }))
      .toEqual({ available: true, reason: null });
    expect(workToolAvailability("ios", { ...LOCAL_MAC, supportsIosSimulator: false })).toEqual({
      available: false,
      reason: IOS_RUNTIME_UNSUPPORTED_REASON,
    });
    expect(workToolAvailability("ios", {
      isRemoteProject: true,
      supportsIosSimulator: false,
      isWebClient: false,
    })).toEqual({
      available: false,
      reason: IOS_RUNTIME_UNSUPPORTED_REASON,
    });
  });

  it("keeps the hosted web client on the full Apple tool when the runtime is a Mac", () => {
    const webMac: WorkToolContext = {
      isRemoteProject: false,
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

  it("still treats App Control as this-computer-only", () => {
    expect(workToolAvailability("app-control", { ...LOCAL_MAC, isRemoteProject: true })).toEqual({
      available: false,
      reason: "Runs on this computer only",
    });
    expect(isReadOnlyWorkTool("app-control", { ...LOCAL_MAC, isWebClient: true })).toBe(true);
    expect(workToolAvailability("app-control", { ...LOCAL_MAC, isWebClient: true }))
      .toEqual({ available: true, reason: null });
  });
});
