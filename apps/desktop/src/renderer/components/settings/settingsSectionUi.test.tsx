/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Lifebuoy } from "@phosphor-icons/react";
import { ConsentToggleSection } from "./settingsSectionUi";

/**
 * The two privacy toggles — analytics and automatic diagnostics — are this one
 * component. What is tested here is the only thing a consent control must never
 * get wrong: the switch shows what was PERSISTED, not what was clicked.
 */

type Status = { enabled: boolean; limit: number };

function renderToggle(overrides: {
  read?: () => Promise<Status>;
  write?: (enabled: boolean) => Promise<Status>;
}) {
  return render(
    <ConsentToggleSection<Status>
      id="consent"
      title="Diagnostics"
      description="Send ADE a report when something breaks."
      icon={Lifebuoy}
      brandColor="#60A5FA"
      label="Share diagnostics with ADE"
      body="What leaves this computer, in one line."
      footnote={(status) => `At most ${status?.limit ?? 3} a day.`}
      read={overrides.read}
      write={overrides.write}
      readErrorMessage="This setting is unavailable right now."
      writeErrorMessage="ADE could not save this setting."
    />,
  );
}

afterEach(cleanup);

describe("ConsentToggleSection", () => {
  it("renders the state it read and then the state the write returned", async () => {
    // The write's answer wins over the click: `setAutoDiagnosticsEnabled` can
    // persist something other than what was asked for when the ledger is
    // contended, and a toggle that showed the request would show an "off" that
    // is really on.
    const write = vi.fn(async () => ({ enabled: true, limit: 3 }));
    renderToggle({ read: async () => ({ enabled: true, limit: 3 }), write });

    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() => expect(write).toHaveBeenCalledWith(false));
    // Asked for off, told it stayed on: the switch says on.
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
  });

  it("says so when the setting cannot be read, and does not offer a click", async () => {
    renderToggle({
      read: async () => {
        throw new Error("bridge down");
      },
      write: async () => ({ enabled: false, limit: 3 }),
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("This setting is unavailable right now."),
    );
    // No status means nothing to toggle: the switch stays disabled rather
    // than writing against a value nobody has.
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  });

  it("surfaces a failed write without pretending the click landed", async () => {
    const write = vi.fn(async () => {
      throw new Error("no");
    });
    renderToggle({ read: async () => ({ enabled: true, limit: 3 }), write });

    const toggle = await screen.findByRole("switch");
    // The switch exists before `read` resolves and is disabled until it does; a
    // click landing in that window calls nothing and the assertion below would
    // time out on an alert that was never going to appear.
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("ADE could not save this setting."),
    );
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
});
