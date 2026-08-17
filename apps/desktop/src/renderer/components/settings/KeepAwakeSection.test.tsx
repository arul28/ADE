/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { KeepAwakeSnapshot } from "../../../shared/types/keepAwake";
import { KeepAwakeControls } from "./KeepAwakeSection";

const originalAde = (globalThis.window as any)?.ade;

function snapshot(overrides: Partial<KeepAwakeSnapshot> = {}): KeepAwakeSnapshot {
  return {
    preferences: { level: "never" },
    lidClosedSupported: true,
    lidClosedActive: false,
    levelError: null,
    systemSleep: null,
    ...overrides,
  };
}

function installAde(handlers: {
  get: () => Promise<KeepAwakeSnapshot>;
  setLevel?: (level: string) => Promise<KeepAwakeSnapshot>;
  fix?: () => Promise<{ ok: boolean; error: string | null; snapshot: KeepAwakeSnapshot }>;
}) {
  (globalThis.window as any).ade = {
    keepAwakeGet: handlers.get,
    keepAwakeSetLevel: handlers.setLevel ?? (async () => snapshot()),
    keepAwakeFixSystemSleep:
      handlers.fix ?? (async () => ({ ok: true, error: null, snapshot: snapshot() })),
  };
}

afterEach(() => {
  cleanup();
  (globalThis.window as any).ade = originalAde;
});

describe("KeepAwakeControls", () => {
  it("defaults to Never and states each level's own limit", async () => {
    installAde({ get: async () => snapshot() });
    render(<KeepAwakeControls />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /Never/ })).toBeTruthy());
    expect(screen.getByRole("radio", { name: /Never/ }).getAttribute("aria-checked")).toBe("true");
    // The load-bearing line: a wake lock stops idle sleep and does not survive
    // a closed lid. It must not be softened.
    expect(screen.getByText("Stops idle sleep. Not the lid.")).toBeTruthy();
  });

  it("discloses that the lid-closed level outlives quitting ADE", async () => {
    installAde({ get: async () => snapshot() });
    render(<KeepAwakeControls />);

    // `pmset -a disablesleep 1` is machine-wide, covers battery, and is
    // deliberately not reverted at quit. The limit line has to say so, or a
    // user can enable it, quit, and bag a Mac that never sleeps.
    await waitFor(() =>
      expect(screen.getByText("Needs your password. Stays on after you quit.")).toBeTruthy(),
    );
  });

  it("warns when the lid-closed level is stored but the Mac can still sleep", async () => {
    // The OS-vs-ADE desync: `sudo pmset -a disablesleep 0`, or an OS update,
    // clears the switch without any ADE call failing. Nothing else in the UI
    // would say so, and the radio would keep asserting the Mac stays awake.
    const setLevel = vi.fn(async () =>
      snapshot({ preferences: { level: "lid-closed" }, lidClosedActive: true }),
    );
    installAde({
      get: async () => snapshot({ preferences: { level: "lid-closed" }, lidClosedActive: false }),
      setLevel,
    });
    render(<KeepAwakeControls />);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("This Mac can still sleep."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn on again" }));
    await waitFor(() => expect(setLevel).toHaveBeenCalledWith("lid-closed"));
    // Back in force: the warning goes with it.
    await waitFor(() => expect(screen.queryByText("This Mac can still sleep.")).toBeNull());
  });

  it("keeps the Turn on again button outside the live region", async () => {
    // A focusable control inside `role="alert"` is re-announced on every
    // re-render of the row and announces out of order with the focus itself.
    // The live region is the sentence; the button is a sibling.
    installAde({
      get: async () => snapshot({ preferences: { level: "lid-closed" }, lidClosedActive: false }),
    });
    render(<KeepAwakeControls />);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("This Mac can still sleep."),
    );
    const button = screen.getByRole("button", { name: "Turn on again" });
    expect(screen.getByRole("alert").contains(button)).toBe(false);
  });

  it("takes its Mac-or-PC copy from the preload bridge, not from navigator", async () => {
    // One canonical platform predicate. A second `isMacPlatform()` living in
    // this file shadowed `renderer/lib/platform`'s export and was free to drift
    // from it. jsdom's `navigator.platform` is not a Mac, so the Mac copy below
    // can only come from the bridge.
    installAde({ get: async () => snapshot() });
    (globalThis.window as any).ade.app = { runtimeTarget: { platform: "darwin", arch: "arm64" } };
    const { unmount } = render(<KeepAwakeControls />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /Never/ })).toBeTruthy());
    expect(screen.getByRole("radiogroup").getAttribute("aria-label"))
      .toBe("Keep this Mac awake while agents work");
    expect(screen.getByText("Turns pause when this Mac sleeps")).toBeTruthy();
    unmount();

    installAde({ get: async () => snapshot({ lidClosedSupported: false }) });
    (globalThis.window as any).ade.app = { runtimeTarget: { platform: "win32", arch: "x64" } };
    render(<KeepAwakeControls />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /Never/ })).toBeTruthy());
    expect(screen.getByRole("radiogroup").getAttribute("aria-label"))
      .toBe("Keep this PC awake while agents work");
    expect(screen.getByText("Turns pause when this PC sleeps")).toBeTruthy();
  });

  it("stays quiet about the desync while the level is in force, or already explained", async () => {
    installAde({
      get: async () => snapshot({ preferences: { level: "lid-closed" }, lidClosedActive: true }),
    });
    const { unmount } = render(<KeepAwakeControls />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Never/ })).toBeTruthy());
    expect(screen.queryByText("This Mac can still sleep.")).toBeNull();
    unmount();

    // A stored level that never took effect already has its own sentence; two
    // alarms about one disagreement is one too many.
    installAde({
      get: async () =>
        snapshot({
          preferences: { level: "lid-closed" },
          lidClosedActive: false,
          levelError: "You cancelled the password prompt.",
        }),
    });
    render(<KeepAwakeControls />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("You cancelled the password prompt."),
    );
    expect(screen.queryByText("This Mac can still sleep.")).toBeNull();
  });

  it("omits the lid-closed level entirely where it is unsupported", async () => {
    installAde({ get: async () => snapshot({ lidClosedSupported: false }) });
    render(<KeepAwakeControls />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /Never/ })).toBeTruthy());
    // Absent, not disabled: a greyed row would imply the capability is coming.
    expect(screen.queryByText("Even with the lid closed")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("persists the picked level through the machine", async () => {
    const setLevel = vi.fn(async () => snapshot({ preferences: { level: "while-away" } }));
    installAde({ get: async () => snapshot(), setLevel });
    render(<KeepAwakeControls />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /While I'm away/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: /While I'm away/ }));

    await waitFor(() => expect(setLevel).toHaveBeenCalledWith("while-away"));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /While I'm away/ }).getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("surfaces a stored level that is not actually in force", async () => {
    installAde({
      get: async () =>
        snapshot({ levelError: "You cancelled the password prompt." }),
    });
    render(<KeepAwakeControls />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("You cancelled the password prompt."),
    );
  });

  it("warns about a system sleep timer and puts the password cost on the button", async () => {
    const fix = vi.fn(async () => ({
      ok: true,
      error: null,
      snapshot: snapshot({ systemSleep: { sleepMinutesOnAc: 0, fixable: true, fixNeedsPassword: true } }),
    }));
    installAde({
      get: async () =>
        snapshot({ systemSleep: { sleepMinutesOnAc: 10, fixable: true, fixNeedsPassword: true } }),
      fix,
    });
    render(<KeepAwakeControls />);

    await waitFor(() => expect(screen.getByText(/Agents will stop anyway/)).toBeTruthy());
    const button = screen.getByRole("button", { name: "Fix — needs your password" });
    fireEvent.click(button);
    await waitFor(() => expect(fix).toHaveBeenCalled());
    // Fixed: the timer is gone, so the warning goes with it.
    await waitFor(() => expect(screen.queryByText(/Agents will stop anyway/)).toBeNull());
  });

  it("says nothing when the system already never sleeps on power", async () => {
    installAde({
      get: async () =>
        snapshot({ systemSleep: { sleepMinutesOnAc: 0, fixable: true, fixNeedsPassword: true } }),
    });
    render(<KeepAwakeControls />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Never/ })).toBeTruthy());
    expect(screen.queryByText(/Agents will stop anyway/)).toBeNull();
  });
});
