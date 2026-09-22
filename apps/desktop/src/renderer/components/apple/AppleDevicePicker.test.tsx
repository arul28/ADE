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
    onStart: vi.fn(),
    onCreate: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  const view = render(<AppleDevicePicker {...props} />);
  return { ...props, ...view };
}

const sectionOf = (container: HTMLElement, label: string) =>
  container.querySelector(`[data-apple-picker-section="${label}"]`) as HTMLElement;

describe("AppleDevicePicker inventory line", () => {
  it("names the runtime and counts what is installed and running", () => {
    const { container } = renderPicker();
    expect(container.querySelector("[data-apple-inventory-line]")?.textContent)
      .toBe("iOS 26.2 and watchOS 26.2 · 5 simulators installed · 2 running");
  });

  it("says that one runtime install serves any number of devices", () => {
    renderPicker();
    expect(screen.getByText(/One runtime install serves any number of simulators/)).toBeTruthy();
  });

  it("puts the disk total next to the counts, once it has been measured", () => {
    const { container } = renderPicker({ disk: DISK });
    expect(container.querySelector("[data-apple-inventory-disk]")?.textContent).toBe("18.0 GB of device data");
  });

  it("says it is measuring rather than guessing a number", () => {
    const { container } = renderPicker({ measuringDisk: true });
    expect(container.querySelector("[data-apple-inventory-disk]")?.textContent).toBe("Measuring disk…");
  });

  it("shows no disk claim at all before the lazy read arrives", () => {
    const { container } = renderPicker();
    expect(container.querySelector("[data-apple-inventory-disk]")).toBeNull();
  });
});

describe("AppleDevicePicker lane slot", () => {
  it("shows NO hero when the lane owns nothing, and says so", () => {
    const { container } = renderPicker({ laneDevice: null });
    // The round-5 defect: the newest installed iPhone heroed as "your device".
    expect(container.querySelector("[data-apple-hero-card]")).toBeNull();
    expect(container.querySelector("[data-apple-no-lane-device]")).toBeTruthy();
    expect(screen.getByText("This lane has no Apple device yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a new simulator for this lane" })).toBeTruthy();
  });

  it("never heroes a device just because it is the newest iPhone", () => {
    const { container } = renderPicker({
      laneDevice: null,
      owners: [],
      installed: [
        simulator({ udid: "old", name: "iPhone 16", runtime: "iOS 18.4" }),
        simulator({ udid: "new", name: "iPhone Air", runtime: "iOS 26.2" }),
      ],
    });
    expect(container.querySelector("[data-apple-hero-card]")).toBeNull();
    // Both of them stay in Available, where they are one of two things to pick.
    const available = sectionOf(container, "Available");
    expect(within(available).getByRole("button", { name: "Start iPhone Air" })).toBeTruthy();
    expect(within(available).getByRole("button", { name: "Start iPhone 16" })).toBeTruthy();
  });

  it("heroes the lane's OWN device, and keeps it out of Available", () => {
    const { container } = renderPicker({ laneDevice: laneDevice({ udid: "max" }) });
    const hero = container.querySelector("[data-apple-hero-card='max']") as HTMLElement;
    expect(hero).toBeTruthy();
    expect(within(hero).getByText("iPhone 17 Pro Max")).toBeTruthy();
    expect(container.querySelector("[data-apple-device-card='max']")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Start iPhone 17 Pro Max" })).toHaveLength(1);
  });

  it("says the lane's registered device is gone rather than that it has none", () => {
    renderPicker({ laneDevice: laneDevice({ udid: "deleted", name: "ADE · Mine" }) });
    expect(screen.getByText("ADE · Mine is registered to this lane but is not installed any more."))
      .toBeTruthy();
    expect(screen.queryByText("This lane has no Apple device yet.")).toBeNull();
  });

  it("defaults Create to a template that can actually be cloned", () => {
    const props = renderPicker();
    const select = screen.getByLabelText("Device to copy") as HTMLSelectElement;
    // `pro` and `repro` are booted (simctl refuses to clone a booted device)
    // and `repro` is another lane's besides, so the default is the max.
    expect(select.value).toBe("max");
    expect(
      [...select.options].some((option) => option.textContent === "ADE Repro · iPhone 17 Pro · iOS 26.2"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create a new simulator for this lane" }));
    expect(props.onCreate).toHaveBeenCalledWith("max");
  });
});

describe("AppleDevicePicker available group", () => {
  it("holds every installed device no lane owns, and counts them", () => {
    const { container } = renderPicker();
    const available = sectionOf(container, "Available");
    expect(available.querySelector("[data-apple-section-count]")?.textContent).toBe("4");
    expect([...available.querySelectorAll("[data-apple-device-card]")].map((node) =>
      node.getAttribute("data-apple-device-card"))).toEqual(["pro", "max", "pad", "watch"]);
  });

  it("groups by family, in §B2's order, from the device type identifier", () => {
    const { container } = renderPicker();
    const available = sectionOf(container, "Available");
    expect([...available.querySelectorAll("[data-apple-family] h4")].map((node) => node.textContent))
      .toEqual(["iPhone", "iPad", "Apple Watch"]);
    const pad = available.querySelector("[data-apple-family='ipad']") as HTMLElement;
    expect(within(pad).getByRole("button", { name: "Start iPad Pro 13-inch M4" })).toBeTruthy();
  });

  it("files a device by its identifier even when the service's family disagrees", () => {
    const { container } = renderPicker({
      owners: [],
      installed: [
        // Both carry `family: "iphone"` from the service. The identifier wins.
        simulator({ udid: "tv", name: "Apple TV 4K", runtime: "tvOS 26.2", deviceTypeIdentifier: `${T}Apple-TV-4K-3rd-generation-1080p` }),
        simulator({ udid: "vision", name: "Apple Vision Pro", runtime: "visionOS 26.2", deviceTypeIdentifier: `${T}Apple-Vision-Pro` }),
      ],
    });
    const tv = container.querySelector("[data-apple-family='tv']") as HTMLElement;
    expect(within(tv).getByRole("button", { name: "Start Apple TV 4K" })).toBeTruthy();
    const vision = container.querySelector("[data-apple-family='vision']") as HTMLElement;
    expect(within(vision).getByRole("button", { name: "Start Apple Vision Pro" })).toBeTruthy();
  });

  it("says a stopped simulator only needs a boot, and downloads nothing", () => {
    const { container } = renderPicker();
    expect(container.querySelector("[data-apple-boot-hint]")?.textContent)
      .toMatch(/stopped simulator only needs a boot/);
  });

  it("names the action for the device it acts on, and opens what is already booted", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: "Open iPhone 17 Pro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start iPhone 17 Pro Max" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Series 10" })).toBeTruthy();
  });

  it("shows the model under a custom name, and never repeats a name that is the model", () => {
    const { container } = renderPicker({
      owners: [],
      installed: [simulator({ udid: "repro", name: "ADE Repro" }), simulator({ udid: "max", name: "iPhone 17 Pro Max", deviceTypeIdentifier: `${T}iPhone-17-Pro-Max` })],
    });
    const repro = container.querySelector("[data-apple-device-card='repro']") as HTMLElement;
    expect(within(repro).getByText("ADE Repro")).toBeTruthy();
    expect(repro.querySelector("[data-apple-model-line]")?.textContent).toBe("iPhone 17 Pro");
    const max = container.querySelector("[data-apple-device-card='max']") as HTMLElement;
    expect(max.querySelector("[data-apple-model-line]")).toBeNull();
  });

  it("carries each device's own disk use once it is measured", () => {
    const { container } = renderPicker({ disk: DISK });
    const pro = container.querySelector("[data-apple-device-card='pro']") as HTMLElement;
    expect(within(pro).getByText("iOS 26.2 · Running · 5.0 GB")).toBeTruthy();
    // Unmeasured devices keep the plain line rather than claiming zero.
    const pad = container.querySelector("[data-apple-device-card='pad']") as HTMLElement;
    expect(within(pad).getByText("iOS 26.2 · Stopped")).toBeTruthy();
  });

  it("starts the device that was clicked, and locks every card while one is in flight", () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Start iPad Pro 13-inch M4" }));
    expect(props.onStart).toHaveBeenCalledWith("pad");

    cleanup();
    renderPicker({ pending: "pad" });
    expect(screen.getByRole("button", { name: "Open iPhone 17 Pro" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Create a new simulator for this lane" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("AppleDevicePicker in-use-elsewhere group", () => {
  it("names the owning lane and offers NO Open or Start", () => {
    const { container } = renderPicker();
    const elsewhere = sectionOf(container, "In use elsewhere");
    const card = within(elsewhere).getByText("ADE Repro").closest("[data-apple-elsewhere-card]") as HTMLElement;
    expect(card.getAttribute("data-apple-elsewhere-card")).toBe("repro");
    expect(within(card).getByText("In use by lane Apple sim preview")).toBeTruthy();
    // The exact defect: Open on a device another lane is mid-test in.
    expect(screen.queryByRole("button", { name: "Open ADE Repro" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start ADE Repro" })).toBeNull();
    expect(container.querySelector("[data-apple-device-card='repro']")).toBeNull();
  });

  it("keeps another lane's device out of Available and out of the hero", () => {
    const { container } = renderPicker();
    const available = sectionOf(container, "Available");
    expect(within(available).queryByText("ADE Repro")).toBeNull();
    expect(container.querySelector("[data-apple-hero-card]")).toBeNull();
  });

  it("puts a takeover behind a confirmation that names the lane it interrupts", () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Take over ADE Repro" }));

    expect(screen.getByText(
      "Take ADE Repro from lane Apple sim preview? That lane loses the device and its live view — the simulator itself keeps running.",
    )).toBeTruthy();
    // Nothing has happened yet — the first click only asks.
    expect(props.onStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Take ADE Repro from lane Apple sim preview" }));
    expect(props.onStart).toHaveBeenCalledWith("repro");
  });

  it("backs out of a takeover without touching the device", () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Take over ADE Repro" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/That lane loses the device/)).toBeNull();
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it("says 'another lane' rather than a hex id it cannot name", () => {
    renderPicker({ owners: [{ ...REPRO_OWNER, laneName: null }] });
    expect(screen.getByText("In use by another lane")).toBeTruthy();
    expect(screen.queryByText(/dca9f144/)).toBeNull();
  });

  it("drops the group entirely when no other lane holds anything", () => {
    const { container } = renderPicker({ owners: [] });
    expect(container.querySelector("[data-apple-picker-section='In use elsewhere']")).toBeNull();
    expect(sectionOf(container, "Available").querySelector("[data-apple-section-count]")?.textContent).toBe("5");
  });
});

describe("AppleDevicePicker page", () => {
  it("never calls the page 'iOS Simulators' again", () => {
    renderPicker();
    expect(screen.queryByRole("heading", { name: "iOS Simulators" })).toBeNull();
    expect(screen.queryByText("iOS Simulators")).toBeNull();
  });

  it("keeps §B2's footer, verbatim", () => {
    renderPicker();
    expect(screen.getByText("Only simulators already installed appear here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("says where simulators come from when there are none", () => {
    renderPicker({ installed: [] });
    expect(screen.getByText("No Apple simulators are installed.")).toBeTruthy();
    expect(screen.getByText(/Install one in Xcode/)).toBeTruthy();
    expect(screen.queryByText("This lane has no Apple device yet.")).toBeNull();
  });

  it("wears the tools grid's card and backdrop, and nothing see-through", () => {
    const { container } = renderPicker();
    expect(container.querySelector(".ade-tool-picker-backdrop")).toBeTruthy();
    expect(container.querySelectorAll(".ade-tool-card").length).toBeGreaterThan(1);
    // Rule zero: nothing in this feature is see-through over the device.
    expect(container.querySelector(".bg-bg\\/80, .bg-bg\\/90, .bg-bg\\/95")).toBeNull();
    // The page's statements of fact are opaque and still, not lifting cards.
    expect(container.querySelector("[data-apple-inventory]")?.className)
      .toContain("ade-tool-card-solid");
  });

  it("never truncates a device name with an ellipsis", () => {
    const { container } = renderPicker({
      owners: [],
      installed: [simulator({ udid: "long", name: "iPhone 17 Pro Max (2nd generation)" })],
    });
    expect(container.querySelector(".truncate")).toBeNull();
    expect(container.querySelector(".text-ellipsis")).toBeNull();
  });

  it.each([360, 900])("fits its container at %ipx", (width) => {
    const { container } = renderPicker({ disk: DISK, laneDevice: laneDevice({ udid: "max" }) });
    expectNoHorizontalOverflow(container, width);
  });
});
