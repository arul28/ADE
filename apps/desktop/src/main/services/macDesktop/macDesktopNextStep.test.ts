import { describe, expect, it } from "vitest";

import type { ComputerUseActionEffect } from "../../../shared/types/agentObservation";
import {
  MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
  MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
  MAC_DESKTOP_USER_HAS_CONTROL_CODE,
  type MacDesktopElement,
  type MacDesktopLeaseState,
  type MacDesktopObservation,
  type MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type { MacDesktopLeaseDecision } from "./macDesktopLease";
import { macDesktopNextStep, macDesktopRefusedNextStep } from "./macDesktopNextStep";

/**
 * The next input method for an unconfirmed action.
 *
 * This is the decision an agent follows instead of repeating the accessibility
 * action that just did nothing, so each branch is pinned through the exported
 * function: the element's state, its app, the mode and the caller's lease.
 */

const unconfirmed = (reason = "nothing on screen changed"): ComputerUseActionEffect => ({ status: "unconfirmed", reason });

const element = (overrides: Partial<MacDesktopElement> = {}): MacDesktopElement => ({
  index: 1,
  handle: "obs-1:e:1",
  role: "AXButton",
  subrole: null,
  title: "Save",
  label: null,
  value: null,
  identifier: null,
  help: null,
  enabled: true,
  focused: false,
  actions: ["AXPress"],
  frame: { x: 10, y: 20, width: 40, height: 20 },
  center: { x: 30, y: 40 },
  windowId: 5,
  pid: 42,
  parentIndex: null,
  ...overrides,
});

const appWindow = (bundleId: string | null): MacDesktopWindow => ({
  id: 5,
  pid: 42,
  appName: "App",
  bundleId,
  title: "Window",
  frame: { x: 0, y: 0, width: 900, height: 700 },
  laneId: "lane-1",
  origin: "claimed",
  onDisplayId: 7,
  minimized: false,
  singleInstance: false,
});

const withWindow = (bundleId: string | null, elements: MacDesktopElement[]): MacDesktopObservation => ({
  id: "obs-1",
  laneId: "lane-1",
  capturedAt: "2026-01-01T00:00:00Z",
  screenshotPath: "/tmp/obs.png",
  mapPath: null,
  display: { width: 1000, height: 800, scale: 2 },
  windows: [appWindow(bundleId)],
  elements,
  elementCount: elements.length,
  truncated: false,
  caption: null,
});

const leaseState: MacDesktopLeaseState = {
  laneId: "lane-1",
  holder: "agent",
  holderId: "chat-1",
  holderLabel: null,
  grantedAt: "2026-01-01T00:00:00Z",
  expiresAt: "2026-01-01T00:05:00Z",
};

const heldLease: MacDesktopLeaseDecision = { ok: true, lease: leaseState };
const noLease: MacDesktopLeaseDecision = {
  ok: false,
  code: MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
  lease: null,
  message: "Real pointer and keyboard input needs the user's permission on this display.",
};
const userDriving: MacDesktopLeaseDecision = {
  ok: false,
  code: MAC_DESKTOP_USER_HAS_CONTROL_CODE,
  lease: leaseState,
  message: "Someone is driving this display right now.",
};
const otherChat: MacDesktopLeaseDecision = {
  ok: false,
  code: MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
  lease: leaseState,
  message: "Another chat holds real input on this display.",
};

const nextFor = (overrides: Partial<Parameters<typeof macDesktopNextStep>[0]> = {}) =>
  macDesktopNextStep({
    action: "click",
    mode: "accessibility",
    effect: unconfirmed(),
    resolved: element(),
    before: withWindow("com.apple.TextEdit", [element()]),
    lease: heldLease,
    ...overrides,
  });

describe("macDesktopNextStep only advises on an unconfirmed ladder action", () => {
  it.each(["observed", "not_checked", "waiting_for_approval"] as const)("returns null for a %s effect", (status) => {
    expect(nextFor({ effect: { status, reason: "the screen changed" } })).toBeNull();
  });

  it("returns null for an action that is not on the ladder", () => {
    expect(nextFor({ action: "drag" })).toBeNull();
    expect(nextFor({ action: "move" })).toBeNull();
  });
});

describe("macDesktopNextStep reads the element's state", () => {
  it("tells a disabled element to observe, never to escalate", () => {
    const next = nextFor({ resolved: element({ enabled: false }) });
    expect(next?.method).toBe("observe");
    expect(next?.command).toBeNull();
    expect(next?.reason).toContain("disabled");
  });

  it("escalates a button with no AXPress action to real input at its centre", () => {
    const next = nextFor({ resolved: element({ actions: ["AXShowMenu"] }) });
    expect(next?.method).toBe("real_input");
    expect(next?.command).toBe("ade mac-desktop click --x 30 --y 40 --real --text");
    expect(next?.reason).toContain("no AXPress action");
  });

  it("reproduces a right click rather than advising a left click", () => {
    const next = nextFor({ resolved: element({ actions: [] }), button: "right" });
    expect(next?.method).toBe("real_input");
    expect(next?.command).toContain("--right");
    expect(next?.command).not.toContain("--double");
  });

  it("reproduces a double click and gives no command for a triple click", () => {
    const double = nextFor({ resolved: element({ actions: [] }), count: 2 });
    expect(double?.command).toContain("--double");
    const triple = nextFor({ resolved: element({ actions: [] }), count: 3 });
    expect(triple?.method).toBe("real_input");
    expect(triple?.command).toBeNull();
  });

  it("treats a missing enabled field as unknown, not disabled", () => {
    const next = nextFor({ resolved: element({ enabled: undefined as unknown as boolean }) });
    expect(next?.method).toBe("observe");
    expect(next?.reason).not.toContain("disabled");
    expect(next?.reason).toContain("probably applied");
  });

  it("treats a missing actions list as unknown, not as no-press", () => {
    const next = nextFor({ resolved: element({ actions: undefined as unknown as string[] }) });
    expect(next?.method).not.toBe("real_input");
    expect(next?.command).toBeNull();
  });

  it("names a passive role when accessibility could not press it", () => {
    const next = nextFor({ resolved: element({ role: "AXStaticText", actions: ["AXShowMenu"] }) });
    expect(next?.method).toBe("real_input");
    expect(next?.reason).toContain("AXStaticText");
    expect(next?.reason).toContain("only shows content");
  });
});

describe("macDesktopNextStep follows the caller's lease", () => {
  it("asks for the lease, with the lease command, when nobody holds it", () => {
    const next = nextFor({ resolved: element({ actions: [] }), lease: noLease });
    expect(next?.method).toBe("lease");
    expect(next?.command).toContain("mac-desktop lease");
    expect(next?.command).not.toContain("--real");
  });

  it.each([
    ["the user is driving", userDriving],
    ["another chat holds it", otherChat],
  ])("waits when %s, and never prints a --real command", (_label, lease) => {
    const next = nextFor({ resolved: element({ actions: [] }), lease: lease as MacDesktopLeaseDecision });
    expect(next?.method).toBe("observe");
    expect(next?.command).toBeNull();
    expect(next?.command ?? "").not.toContain("--real");
    expect(next?.reason).toContain("wait");
  });
});

describe("macDesktopNextStep spots web content in a real browser", () => {
  const webArea = element({ index: 2, role: "AXWebArea", actions: [], parentIndex: null, windowId: 5 });
  const webText = element({ index: 1, role: "AXStaticText", title: null, value: "Read more", actions: [], parentIndex: 2 });

  it("sends web content in a known browser to the ADE browser", () => {
    const next = nextFor({ resolved: webText, before: withWindow("com.apple.Safari", [webText, webArea]) });
    expect(next?.method).toBe("browser");
    expect(next?.command).toBeNull();
    expect(next?.reason).toContain("web page");
  });

  it("does not send web content in a non-browser app (an Electron app) to the browser", () => {
    const next = nextFor({ resolved: webText, before: withWindow("com.github.Electron", [webText, webArea]) });
    expect(next?.method).toBe("real_input");
    expect(next?.reason).not.toContain("web page in a browser");
  });
});

describe("macDesktopNextStep after real input was already delivered", () => {
  it("tells the agent to observe, not to retry real input", () => {
    const next = nextFor({ mode: "real", resolved: element({ actions: [] }) });
    expect(next?.method).toBe("observe");
    expect(next?.command).toBeNull();
    expect(next?.reason).toContain("real input was delivered");
  });
});

describe("macDesktopRefusedNextStep", () => {
  const refused = (overrides: Partial<Parameters<typeof macDesktopRefusedNextStep>[0]> = {}) =>
    macDesktopRefusedNextStep({
      action: "click",
      mode: "accessibility",
      message: 'AXStaticText "Read more" answered no press action.',
      resolved: null,
      before: null,
      lease: noLease,
      ...overrides,
    });

  it("carries the same lease advice a refused accessibility click would", () => {
    const next = refused();
    expect(next?.method).toBe("lease");
    expect(next?.command).toContain("mac-desktop lease");
  });

  it("only fires for an accessibility click whose refusal says no press action", () => {
    expect(refused({ mode: "real" })).toBeNull();
    expect(refused({ action: "type" })).toBeNull();
    expect(refused({ message: "the element did not answer in time" })).toBeNull();
  });

  it("tells a disabled element to observe, not to ask for a lease", () => {
    const next = refused({ resolved: element({ enabled: false }) });
    expect(next?.method).toBe("observe");
    expect(next?.command).toBeNull();
    expect(next?.reason).toContain("disabled");
  });

  it("sends a refused click on browser web content to the ADE browser", () => {
    const webArea = element({ index: 2, role: "AXWebArea", actions: [], parentIndex: null });
    const webText = element({ index: 1, role: "AXStaticText", title: null, value: "Read more", actions: [], parentIndex: 2 });
    const next = refused({ resolved: webText, before: withWindow("com.apple.Safari", [webText, webArea]) });
    expect(next?.method).toBe("browser");
  });
});
