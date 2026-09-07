/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppControlToolbar } from "./AppControlToolbar";

afterEach(cleanup);

function renderToolbar(appLabel: string) {
  return render(
    <AppControlToolbar
      appLabel={appLabel}
      hasSession={false}
      recents={[]}
      launchCommand=""
      onLaunchCommandChange={vi.fn()}
      onLaunch={vi.fn()}
      canLaunch={false}
      launching={false}
      cdpPort=""
      onCdpPortChange={vi.fn()}
      onConnect={vi.fn()}
      connecting={false}
      onHelpWireCdp={null}
      drivers={null}
      activeDriver="cdp"
      statusWord="no app"
      statusTone="idle"
      statusDetail="Pick an app to drive"
      remoteLabel={null}
      windows={[]}
      activeWindowId={null}
      onSwitchWindow={vi.fn()}
      switching={false}
      controlsDisabled={false}
      pickerOpen={false}
      onPickerOpenChange={vi.fn()}
      renderOverflow={() => null}
    />,
  );
}

describe("AppControlToolbar app picker", () => {
  it("gives the trigger a pixel width budget rather than a self-referential percentage", () => {
    // The shipped bug: `max-w-[46%]` resolved against the trigger's own
    // content-sized wrapper and collapsed the label to its first letter.
    renderToolbar("Playground");
    const trigger = screen.getByLabelText("App Control launch target");
    expect(trigger.className).toContain("min-w-[120px]");
    expect(trigger.className).toContain("max-w-[240px]");
    expect(trigger.className).not.toMatch(/max-w-\[\d+%\]/);
  });

  it("truncates a long app label with an ellipsis instead of clipping it", () => {
    renderToolbar("A very long Electron application label indeed");
    const label = screen.getByText("A very long Electron application label indeed");
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("min-w-0");
  });

  it("shows a short label in full", () => {
    renderToolbar("P");
    expect(screen.getByText("P")).toBeTruthy();
    const trigger = screen.getByLabelText("App Control launch target");
    expect(trigger.textContent).toBe("P");
  });

  it("keeps the chevron from being squeezed out by a long label", () => {
    renderToolbar("A very long Electron application label indeed");
    const trigger = screen.getByLabelText("App Control launch target");
    const caret = trigger.querySelector("svg:last-of-type");
    expect(caret?.getAttribute("class")).toContain("shrink-0");
  });
});
