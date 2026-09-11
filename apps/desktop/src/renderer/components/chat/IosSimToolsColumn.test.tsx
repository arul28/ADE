/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IosSimToolsColumn, type IosSimToolsColumnProps } from "./IosSimToolsColumn";
import type {
  IosSimulatorDeviceSettings,
  IosSimulatorLogRow,
} from "../../../shared/types/iosSimulator";
import { IOS_SIMULATOR_ACCESSIBILITY_OPTIONS } from "../../../shared/types/iosSimulator";

const ACCESSIBILITY_LABELS = [
  "Increase contrast",
  "Reduce motion",
  "Reduce transparency",
  "Bold text",
  "Invert colours",
  "Greyscale",
  "VoiceOver",
];

function deviceSettings(
  overrides: Partial<IosSimulatorDeviceSettings> = {},
): IosSimulatorDeviceSettings {
  return {
    deviceUdid: "device-1",
    appearance: "dark",
    contentSize: "large",
    accessibility: {
      "increase-contrast": false,
      "reduce-motion": true,
      "reduce-transparency": false,
      "bold-text": false,
      "invert-colors": false,
      grayscale: false,
      "voice-over": false,
    },
    location: null,
    statusBarOverridden: false,
    readAt: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

const logRows: IosSimulatorLogRow[] = [
  {
    id: 1,
    at: "2026-04-29T00:00:01.000Z",
    source: "ade",
    level: "action",
    process: null,
    subsystem: null,
    category: null,
    message: "Set the appearance to dark.",
    command: "ade ios-sim ui appearance dark",
  },
  {
    id: 2,
    at: "2026-04-29T00:00:02.000Z",
    source: "device",
    level: "error",
    process: "Example",
    subsystem: "com.example.app",
    category: "default",
    message: "Could not load the profile.",
  },
];

function renderColumn(overrides: Partial<IosSimToolsColumnProps> = {}) {
  const props: IosSimToolsColumnProps = {
    settings: deviceSettings(),
    bundleId: "com.example.app",
    appRunning: true,
    busy: false,
    disabled: false,
    logRows: [],
    logRunning: false,
  logDropped: 0,
  logError: null,
    onSetAppearance: vi.fn(),
    onSetContentSize: vi.fn(),
    onSetAccessibility: vi.fn(),
    onSetLocation: vi.fn(),
    onClearLocation: vi.fn(),
    onSetPermission: vi.fn(),
    onSendPush: vi.fn(),
    onOpenUrl: vi.fn(),
    onRelaunchApp: vi.fn(),
    onTerminateApp: vi.fn(),
    onToggleLog: vi.fn(),
    onCopy: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  const view = render(<IosSimToolsColumn {...props} />);
  return { ...view, props };
}

/** Radix opens menus on pointerdown, and jsdom has none of the pointer plumbing. */
function installRadixDomShims(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = vi.fn(() => false);
  proto.setPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  proto.scrollIntoView = vi.fn();
}

/** Radix's popper measures its content, and jsdom ships no ResizeObserver. */
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Open a value menu by its trigger's accessible name.
 *
 * Keyboard rather than pointer: jsdom has no PointerEvent, so Radix's
 * `button === 0` guard on pointerdown never passes there.
 */
async function openMenu(label: string): Promise<void> {
  fireEvent.keyDown(await screen.findByLabelText(label), { key: "Enter" });
}

describe("IosSimToolsColumn", () => {
  beforeEach(() => {
    installRadixDomShims();
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    cleanup();
    // Radix marks the body inert while a modal menu is up and does not always
    // take it off again once the tree it belonged to unmounts.
    document.body.removeAttribute("inert");
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders one toggle per accessibility option the device answered for", () => {
    renderColumn();

    for (const label of ACCESSIBILITY_LABELS) {
      expect(screen.getByRole("switch", { name: label })).toBeTruthy();
    }
    expect(screen.getAllByRole("switch")).toHaveLength(IOS_SIMULATOR_ACCESSIBILITY_OPTIONS.length);
  });

  // A device that answered nothing is not a device that answered "off". A
  // toggle there would invite a click that writes a value ADE never read.
  it("shows n/a for an option the device did not answer for", () => {
    renderColumn({
      settings: deviceSettings({
        accessibility: {
          "increase-contrast": false,
          "reduce-motion": true,
          "reduce-transparency": false,
          "bold-text": false,
          "invert-colors": false,
          grayscale: false,
          "voice-over": null,
        },
      }),
    });

    expect(screen.queryByRole("switch", { name: "VoiceOver" })).toBeNull();
    expect(screen.getAllByText("n/a")).toHaveLength(1);
    expect(screen.getAllByRole("switch")).toHaveLength(IOS_SIMULATOR_ACCESSIBILITY_OPTIONS.length - 1);
  });

  it("reports the option and its new value when a toggle flips", () => {
    const { props } = renderColumn();

    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    fireEvent.click(screen.getByRole("switch", { name: "Bold text" }));

    expect(props.onSetAccessibility).toHaveBeenCalledWith("reduce-motion", false);
    expect(props.onSetAccessibility).toHaveBeenCalledWith("bold-text", true);
  });

  // `simctl privacy grant` needs a bundle id. `reset` does not, and it is the
  // one that gets a device out of a bad permission state.
  it("needs an app session for grant and revoke but not for reset", () => {
    renderColumn({ bundleId: null });

    expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Revoke" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps Send disabled until the push has a title or a body", () => {
    const { props } = renderColumn();

    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Body"), { target: { value: "Ready to review" } });

    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(props.onSendPush).toHaveBeenCalledWith("", "Ready to review");
  });

  it("sends the preset's own coordinates when a location is picked", async () => {
    const { props } = renderColumn();

    await openMenu("Location");
    fireEvent.click(await screen.findByText("London"));

    expect(props.onSetLocation).toHaveBeenCalledWith(51.5072, -0.1276);
  });

  // The rows cost height a 240px column does not have, so a log nobody started
  // states its size and nothing else.
  it("counts the log rows in the section label and keeps them folded until asked", () => {
    renderColumn({ logRows, logRunning: false });

    expect(screen.getByText("Event log (2)")).toBeTruthy();
    expect(screen.queryByTestId("ios-event-log")).toBeNull();

    fireEvent.click(screen.getByText("Show rows"));

    const log = screen.getByTestId("ios-event-log");
    expect(within(log).getByText("Set the appearance to dark.")).toBeTruthy();
    expect(within(log).getByText("Could not load the profile.")).toBeTruthy();
  });

  // Starting the log is a request to read it, so Start that left the rows
  // folded read as a button that had done nothing.
  it("unfolds the rows once the log is running", () => {
    const { rerender, props } = renderColumn({ logRows, logRunning: false });

    expect(screen.queryByTestId("ios-event-log")).toBeNull();

    rerender(<IosSimToolsColumn {...props} logRows={logRows} logRunning />);

    expect(screen.getByTestId("ios-event-log")).toBeTruthy();
    expect(screen.getByText("Hide rows")).toBeTruthy();
  });
});
