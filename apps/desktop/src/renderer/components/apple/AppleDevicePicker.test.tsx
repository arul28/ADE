/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppleDeviceDiskUsage,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
} from "../../../shared/types/iosSimulator";
import { AppleDevicePicker } from "./AppleDevicePicker";
import { expectNoHorizontalOverflow } from "./testLayout";

afterEach(cleanup);

// jsdom has no canvas: the backdrop's own `onRefused` path is what the picker
// renders under test, which is also what a machine without WebGL shows.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

const T = "com.apple.CoreSimulator.SimDeviceType.";

function simulator(overrides: Partial<AppleInstalledSimulator>): AppleInstalledSimulator {
  return {
    udid: "udid",
    name: "iPhone 17 Pro",
    runtime: "iOS 26.2",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: `${T}iPhone-17-Pro`,
    ...overrides,
  };
}

/**
 * The owner's own machine, as of the round-5 live test: five installed
 * simulators, two booted, and "ADE Repro" held by another lane.
 */
const INSTALLED = [
  simulator({ udid: "pro", name: "iPhone 17 Pro", state: "Booted" }),
  simulator({ udid: "max", name: "iPhone 17 Pro Max", deviceTypeIdentifier: `${T}iPhone-17-Pro-Max` }),
  simulator({ udid: "repro", name: "ADE Repro", state: "Booted" }),
  simulator({
    udid: "pad",
    name: "iPad Pro 13-inch M4",
    family: "ipad",
    deviceTypeIdentifier: `${T}iPad-Pro-13-inch-M4-8GB`,
  }),
  simulator({
    udid: "watch",
    name: "Series 10",
    runtime: "watchOS 26.2",
    family: "watch",
    deviceTypeIdentifier: `${T}Apple-Watch-Series-10-46mm`,
  }),
];

const REPRO_OWNER: AppleSimulatorOwner = {
  udid: "repro",
  laneId: "dca9f144",
  laneName: "Apple sim preview",
  origin: "attached",
  mine: false,
};

function laneDevice(overrides: Partial<AppleLaneDevice> = {}): AppleLaneDevice {
  return {
    laneId: "lane-mine",
    udid: "max",
    name: "iPhone 17 Pro Max",
    origin: "clone",
    family: "iphone",
    runtime: "iOS 26.2",
    createdAt: "2026-09-21T00:00:00.000Z",
    templateUdid: "pro",
    ...overrides,
  };
}

const DISK: AppleDeviceDiskUsage = {
  totalBytes: 18 * 1024 ** 3,
  devices: [
    { udid: "pro", bytes: 5 * 1024 ** 3 },
    { udid: "repro", bytes: 2 * 1024 ** 3 },
    { udid: "pad", bytes: 3 * 1024 ** 3 },
  ],
  root: "/devices",
  measuredAt: "2026-09-21T00:00:00.000Z",
};

function renderPicker(overrides: Partial<React.ComponentProps<typeof AppleDevicePicker>> = {}) {
  const props = {
    installed: INSTALLED,
    owners: [REPRO_OWNER] as readonly AppleSimulatorOwner[],
    laneDevice: null,
    pending: null,
    lastUsedUdid: null,
    refreshing: false,
    onStart: vi.fn<[string], void>(),
    onCreate: vi.fn<[string], void>(),
    onDelete: vi.fn<[string], void>(),
    onRefresh: vi.fn<[], void>(),
    ...overrides,
  };
  const view = render(<AppleDevicePicker {...props} />);
  return { ...props, ...view };
}

const sectionOf = (container: HTMLElement, label: string) =>
  container.querySelector(`[data-apple-picker-section="${label}"]`) as HTMLElement;


const cardOf = (container: HTMLElement, udid: string) =>
  container.querySelector(`[data-apple-device-card="${udid}"]`) as HTMLElement;

/**
 * Keyboard rather than pointer: jsdom has no PointerEvent, so Radix's
 * pointerdown path never fires here. Enter is the same open.
 */
const openMenu = (container: HTMLElement, udid: string) =>
  fireEvent.keyDown(
    container.querySelector(`[data-apple-device-menu="${udid}"]`) as HTMLElement,
    { key: "Enter" },
  );

describe("AppleDevicePicker heading", () => {
  it("leads with Available and drops the round-5 summary box entirely", () => {
    const { container } = renderPicker({ disk: DISK });
    // The owner read the box, counted its numbers, and asked for it to go: the
    // list below says all of it, and a paragraph at the top of a picker sits
    // between him and the thing he came to click.
    expect(container.querySelector("[data-apple-inventory-line]")).toBeNull();
    expect(container.querySelector("[data-apple-inventory-disk]")).toBeNull();
    expect(screen.queryByText(/One runtime install serves any number/)).toBeNull();
    expect(sectionOf(container, "Available")).toBeTruthy();
  });

  it("counts the FREE devices beside the word, not every installed one", () => {
    const { container } = renderPicker();
    // Five installed, one held by another lane.
    expect(container.querySelector("[data-apple-available-count]")?.textContent).toBe("4");
  });

  it("puts one glyph per owned device next to the heading, grouped by family", () => {
    const { container } = renderPicker();
    const glyphs = container.querySelectorAll("[data-apple-glyph]");
    expect(glyphs).toHaveLength(5);
    // Three iPhones, one iPad, one watch — and the held one reads as taken, so
    // the row shows what he has AND what he can reach.
    expect([...glyphs].filter((g) => g.getAttribute("data-apple-glyph") === "taken")).toHaveLength(1);
  });

  it("says the same thing to a screen reader, which cannot count glyphs", () => {
    renderPicker();
    expect(screen.getByText("5 installed, 4 available")).toBeTruthy();
  });

  it("carries the refresh at the top, and nothing at the foot of the page", () => {
    const { container, onRefresh } = renderPicker();
    const refresh = container.querySelector("[data-apple-picker-refresh]") as HTMLElement;
    expect(refresh).toBeTruthy();
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Only simulators already installed appear here/)).toBeNull();
  });
});

describe("AppleDevicePicker device cards", () => {
  it("groups by family and shows every installed device, held ones included", () => {
    const { container } = renderPicker();
    const families = [...container.querySelectorAll("[data-apple-family]")]
      .map((node) => node.getAttribute("data-apple-family"));
    expect(families).toEqual(["iphone", "ipad", "watch"]);
    for (const udid of ["pro", "max", "repro", "pad", "watch"]) {
      expect(cardOf(container, udid)).toBeTruthy();
    }
  });

  it("reads name, then OS and model, for every card at the same height", () => {
    const { container } = renderPicker();
    // "ADE Repro" is renamed and "iPhone 17 Pro" is not; both still carry the
    // model, so a grid of cards does not disagree about its own line count.
    expect(cardOf(container, "repro").textContent).toContain("iOS 26.2 · iPhone 17 Pro");
    expect(cardOf(container, "pro").textContent).toContain("iOS 26.2 · iPhone 17 Pro");
  });

  it("starts the device the card names, on one click anywhere on it", () => {
    const { container, onStart } = renderPicker();
    fireEvent.click(cardOf(container, "pad").querySelector("[data-apple-device-start]") as HTMLElement);
    expect(onStart).toHaveBeenCalledWith("pad");
  });

  it("tags a booted device Running and says nothing about a stopped one", () => {
    const { container } = renderPicker();
    expect(cardOf(container, "pro").textContent).toContain("Running");
    expect(cardOf(container, "max").textContent).not.toContain("Running");
    expect(cardOf(container, "max").textContent).not.toContain("Stopped");
  });

  it("no longer explains that a stopped simulator only needs a boot", () => {
    renderPicker();
    expect(screen.queryByText(/only needs a boot/)).toBeNull();
  });
});

describe("AppleDevicePicker a device another lane holds", () => {
  it("says TAKEN, offers no menu, and cannot be started", () => {
    const { container, onStart } = renderPicker();
    const card = cardOf(container, "repro");
    expect(card.getAttribute("data-apple-device-taken")).toBe("");
    expect(card.textContent).toContain("Taken");
    expect(card.querySelector("[data-apple-device-start]")).toBeNull();
    expect(card.querySelector("[data-apple-device-menu]")).toBeNull();
    fireEvent.click(card);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("offers no takeover at all, which round 5 did", () => {
    renderPicker();
    expect(screen.queryByText(/Take over/)).toBeNull();
    expect(screen.queryByText(/In use by/)).toBeNull();
  });

  it("names the lane holding it for anyone who asks the card", () => {
    const { container } = renderPicker();
    expect(
      cardOf(container, "repro").querySelector("[data-apple-owner-lane]")?.getAttribute("data-apple-owner-lane"),
    ).toBe("dca9f144");
  });

  it("treats every device as free when the host cannot report ownership", () => {
    const { container } = renderPicker({ owners: null });
    expect(container.querySelector("[data-apple-device-taken]")).toBeNull();
    expect(container.querySelector("[data-apple-available-count]")?.textContent).toBe("5");
  });
});

describe("AppleDevicePicker the per-device menu", () => {
  it("needs two clicks to delete, and names the measured size in the second", () => {
    const { container, onDelete } = renderPicker({ disk: DISK });
    openMenu(container, "pro");
    fireEvent.click(screen.getByText("Delete simulator…"));
    expect(onDelete).not.toHaveBeenCalled();
    // The size is the whole reason he asked for this: 5 GB back is a different
    // decision from "delete iPhone 17 Pro".
    const confirm = screen.getByText("Delete for good — frees 5.0 GB");
    fireEvent.click(confirm);
    expect(onDelete).toHaveBeenCalledWith("pro");
  });

  it("still deletes when nothing has measured the device yet", () => {
    const { container, onDelete } = renderPicker();
    openMenu(container, "max");
    fireEvent.click(screen.getByText("Delete simulator…"));
    fireEvent.click(screen.getByText("Delete for good"));
    expect(onDelete).toHaveBeenCalledWith("max");
  });

  it("is absent altogether when the host offers no delete", () => {
    const { container } = renderPicker({ onDelete: undefined });
    expect(container.querySelector("[data-apple-device-menu]")).toBeNull();
  });
});

describe("AppleDevicePicker create a new one", () => {
  it("sits at the foot of the page and offers only devices a clone can be made FROM", () => {
    const { container } = renderPicker();
    const section = sectionOf(container, "Create a new one");
    expect(section).toBeTruthy();
    // `simctl clone` fails on a booted device, and a device another lane holds
    // is not this panel's to copy. Five installed, two booted (one of those
    // held elsewhere) leaves three.
    expect(section.querySelectorAll("[data-apple-create-source]")).toHaveLength(3);
    expect(section.querySelector('[data-apple-create-source="pro"]')).toBeNull();
    expect(section.querySelector('[data-apple-create-source="repro"]')).toBeNull();
  });

  it("names the source device plainly, without repeating its own model", () => {
    const { container } = renderPicker();
    // `appleDeviceModelLine` renders "iPad Pro 13-inch M4 · iPad Pro 13-inch
    // M4" when the name already IS the model, which is what the row showed.
    const row = container.querySelector('[data-apple-create-source="pad"]') as HTMLElement;
    const label = row.querySelector("span")?.textContent ?? "";
    expect(label).toBe("iPad Pro 13-inch M4");
  });

  it("says what a copy costs, and that nothing is downloaded", () => {
    const { container } = renderPicker({ disk: DISK });
    // `simctl clone` duplicates the source's data directory, so the source's
    // measured size IS the estimate. The runtime is not fetched again.
    expect(
      (container.querySelector('[data-apple-create-source="pad"]') as HTMLElement).textContent,
    ).toContain("copy costs about 3.0 GB, no download");
    // Unmeasured devices still say the part that is certain.
    expect(
      (container.querySelector('[data-apple-create-source="max"]') as HTMLElement).textContent,
    ).toContain("already installed, no download");
  });

  it("says it is measuring rather than guessing a number", () => {
    const { container } = renderPicker({ measuringDisk: true });
    expect(
      (container.querySelector('[data-apple-create-source="pad"]') as HTMLElement).textContent,
    ).toContain("measuring…");
  });

  it("defaults to a template that can actually be cloned, and creates from it", () => {
    const { container, onCreate } = renderPicker({ lastUsedUdid: "repro" });
    // "repro" is the last used AND held by another lane, so it is not offered
    // as a source at all and must not be what Create acts on.
    expect(container.querySelector('[data-apple-create-source="repro"]')).toBeNull();
    fireEvent.click(screen.getByLabelText("Create a new simulator for this lane"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onCreate).mock.calls[0]?.[0]).not.toBe("repro");
  });

  it("creates from the row the user picked", () => {
    const { container, onCreate } = renderPicker();
    fireEvent.click(container.querySelector('[data-apple-create-source="pad"]') as HTMLElement);
    fireEvent.click(screen.getByLabelText("Create a new simulator for this lane"));
    expect(onCreate).toHaveBeenCalledWith("pad");
  });

  it("moves the copy-source selection with arrow keys", () => {
    const { container, onCreate } = renderPicker();
    const group = screen.getByRole("radiogroup", { name: "Device to copy" });
    const radio = (udid: string) =>
      container.querySelector(`[data-apple-create-source="${udid}"]`) as HTMLElement;
    const checked = () =>
      within(group).getAllByRole("radio").find((el) => el.getAttribute("aria-checked") === "true");
    // Sources by name: pad, max, watch. The default (newest iPhone) is the one Tab stop.
    expect(radio("max").tabIndex).toBe(0);
    expect(radio("pad").tabIndex).toBe(-1);
    expect(radio("watch").tabIndex).toBe(-1);

    fireEvent.keyDown(radio("max"), { key: "ArrowDown" });
    expect(checked()).toBe(radio("watch"));
    expect(document.activeElement).toBe(radio("watch"));
    expect(radio("watch").tabIndex).toBe(0);
    expect(radio("max").tabIndex).toBe(-1);

    fireEvent.keyDown(radio("watch"), { key: "ArrowDown" });
    expect(checked()).toBe(radio("pad"));
    fireEvent.keyDown(radio("pad"), { key: "ArrowUp" });
    expect(checked()).toBe(radio("watch"));
    fireEvent.keyDown(radio("watch"), { key: "Home" });
    expect(checked()).toBe(radio("pad"));
    expect(document.activeElement).toBe(radio("pad"));
    fireEvent.keyDown(radio("pad"), { key: "End" });
    expect(checked()).toBe(radio("watch"));

    fireEvent.click(screen.getByLabelText("Create a new simulator for this lane"));
    expect(onCreate).toHaveBeenCalledWith("watch");
  });

  it("says when the lane's registered device is gone, where the fix is", () => {
    const { container } = renderPicker({
      laneDevice: laneDevice({ udid: "deleted-in-xcode", name: "Old clone" }),
    });
    expect(
      container.querySelector("[data-apple-lane-device-missing]")?.textContent,
    ).toContain("Old clone is registered to this lane but is not installed any more.");
  });
});

describe("AppleDevicePicker the lane's own device", () => {
  it("stays in its family group, tagged Yours, and is still one click", () => {
    const { container, onStart } = renderPicker({
      laneDevice: laneDevice(),
      owners: [REPRO_OWNER, { udid: "max", laneId: "lane-mine", laneName: "Mine", origin: "clone", mine: true }],
    });
    const card = cardOf(container, "max");
    expect(card.textContent).toContain("Yours");
    // No hero, no section of its own: round 4 lifted this card out of the
    // family groups and five simulators then read as one plus four.
    expect(container.querySelector("[data-apple-hero-card]")).toBeNull();
    fireEvent.click(card.querySelector("[data-apple-device-start]") as HTMLElement);
    expect(onStart).toHaveBeenCalledWith("max");
  });
});

describe("AppleDevicePicker page", () => {
  it("wears the tools grid's card and backdrop, and nothing see-through", () => {
    const { container } = renderPicker();
    expect(container.querySelector("[data-backdrop]")).toBeTruthy();
    expect(cardOf(container, "pro").className).toContain("ade-tool-card");
  });

  it("says where simulators come from when there are none", () => {
    const { container } = renderPicker({ installed: [] });
    expect(container.querySelector("[data-apple-picker-empty]")).toBeTruthy();
    expect(screen.getByText(/Xcode → Settings → Components/)).toBeTruthy();
  });

  it.each([360, 900])("fits its container at %ipx", (width) => {
    const { container } = renderPicker({ disk: DISK });
    expectNoHorizontalOverflow(container, width);
  });

  it("disables every control while a start is in flight", () => {
    const { container, onStart } = renderPicker({ pending: "pro" });
    const start = cardOf(container, "pad").querySelector("[data-apple-device-start]") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
  });
});
