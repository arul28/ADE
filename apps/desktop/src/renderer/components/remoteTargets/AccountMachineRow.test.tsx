/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { AccountMachineRow } from "./AccountMachineRow";
import type { AccountMachineRow as AccountMachineRowModel } from "./remoteMachineModel";

/**
 * The machine row's second line is the whole point of the redesign: presence
 * and power, in one short line, with no empty battery slot on a machine that
 * has no battery.
 */

const NOW = Date.now();

function machine(overrides: Partial<AdeAccountMachine> = {}): AdeAccountMachine {
  return {
    machineKey: "mk-1",
    deviceId: "dev-1",
    name: "Machine",
    customName: null,
    platform: "darwin",
    deviceType: "desktop",
    pubkey: null,
    reachableEndpoints: [
      { kind: "relay", url: "https://ade-tunnel-relay.arulsharma1028.workers.dev/connect/mk-1" },
    ],
    lastSeenAt: NOW - 5_000,
    online: true,
    ...overrides,
  };
}

function row(value: AdeAccountMachine): AccountMachineRowModel {
  return { kind: "account", id: "row-1", machine: value, matchedTargetId: null };
}

function renderRow(value: AdeAccountMachine, connected = false) {
  return render(
    <AccountMachineRow
      row={row(value)}
      section="available"
      busy={false}
      connecting={false}
      connected={connected}
      detailOpen={false}
      onToggleDetail={vi.fn()}
      onConnect={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("AccountMachineRow", () => {
  it("shows the battery percentage for a machine that has a battery", () => {
    renderRow(
      machine({
        name: "MacBook Pro",
        power: { onExternalPower: false, battery: { percent: 97, charging: false } },
      }),
    );
    expect(screen.getByText("Online · 97% battery")).toBeTruthy();
  });

  it("renders no battery slot for a machine that has none", () => {
    renderRow(machine({ name: "Mac Studio", power: { onExternalPower: true } }));
    expect(screen.getByText("Online · plugged in")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("says asleep and offers Wake instead of Connect", () => {
    renderRow(
      machine({
        name: "MacBook Pro",
        sleepState: "asleep",
        sleepStateAt: NOW - 60_000,
        power: { onExternalPower: false, battery: { percent: 82, charging: false } },
      }),
    );
    expect(screen.getByText("Asleep · 82% battery")).toBeTruthy();
    // Connecting is what wakes it, so the button says what the click does.
    expect(screen.getByRole("button", { name: "Wake" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("marks a machine this computer is talking to, and drops the repeated word", () => {
    renderRow(machine({ name: "Mac Studio", power: { onExternalPower: true } }), true);
    // The check says connected, so the line spends itself on the power reading.
    expect(screen.getByLabelText("Connected")).toBeTruthy();
    expect(screen.getByText("Plugged in")).toBeTruthy();
    expect(screen.queryByText("Online · plugged in")).toBeNull();
  });

  it("still says asleep about a machine that announced a suspend on a live channel", () => {
    // The bug this branch exists for: the socket to a sleeping Mac does not
    // report itself closed, so the machine's own announcement has to win.
    renderRow(
      machine({
        name: "MacBook Pro",
        sleepState: "asleep",
        sleepStateAt: NOW - 60_000,
        power: { onExternalPower: false, battery: { percent: 82, charging: false } },
      }),
      true,
    );
    expect(screen.getByText("Asleep · 82% battery")).toBeTruthy();
    expect(screen.queryByLabelText("Connected")).toBeNull();
    expect(screen.getByRole("button", { name: "Wake" })).toBeTruthy();
  });

  it("lights its dot off the same presence its line states", () => {
    // The row resolved presence once and then painted the dot from the raw
    // `online` flag. A Mac that announced its suspend is still inside the
    // directory's 90-second online window, so one row said both things at
    // once: a green dot beside the word "Asleep".
    const { container } = renderRow(
      machine({
        name: "MacBook Pro",
        online: true,
        lastSeenAt: NOW - 20_000,
        sleepState: "asleep",
        sleepStateAt: NOW - 60_000,
        power: { onExternalPower: false, battery: { percent: 82, charging: false } },
      }),
    );
    expect(screen.getByText("Asleep · 82% battery")).toBeTruthy();
    expect(container.querySelector("[data-machine-presence]")?.getAttribute("data-machine-presence"))
      .toBe("asleep");
  });

  it("does not offer to explain an offline machine it just called asleep", () => {
    // Heartbeat aged past the directory's online window but still inside the
    // sleep-inference window: presence says asleep, and the row used to offer
    // "Why offline?" — and, opened, "hasn't checked in recently" — about the
    // machine it had just called asleep two lines above.
    renderRow(
      machine({
        name: "MacBook Pro",
        online: false,
        lastSeenAt: NOW - 3 * 60_000,
        power: { onExternalPower: false, battery: { percent: 82, charging: false } },
      }),
    );
    expect(screen.getByText("Asleep · 82% battery")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Why offline/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Wake" })).toBeTruthy();
  });

  it("keeps the older guidance for a machine that has been silent for hours", () => {
    renderRow(machine({ name: "windows", online: false, lastSeenAt: NOW - 6 * 60 * 60_000 }));
    expect(screen.getByText(/Open ADE on that computer/)).toBeTruthy();
  });
});
