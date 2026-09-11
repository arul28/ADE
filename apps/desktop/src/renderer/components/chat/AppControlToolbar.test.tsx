/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { APP_PICKER_WIDTH_CLASS, AppControlToolbar } from "./AppControlToolbar";

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
  // The width budget is locked as an exported constant rather than asserted as
  // a substring of a `class` attribute: jsdom does no layout, so a class check
  // could never prove the bug it cited (a percentage resolving against a
  // content-sized wrapper), and it broke on any restyle.
  it("uses the named width budget, which is in px and not a percentage", () => {
    expect(APP_PICKER_WIDTH_CLASS).not.toMatch(/max-w-\[\d+%\]/);
    renderToolbar("Playground");
    const trigger = screen.getByLabelText("App Control launch target");
    expect(trigger.className).toContain(APP_PICKER_WIDTH_CLASS);
  });

  it("renders a long app label in full rather than truncating the text itself", () => {
    const label = "A very long Electron application label indeed";
    renderToolbar(label);
    // The ellipsis is CSS; what must be true in the DOM is that the whole
    // string is present, so a screen reader and a tooltip both get it.
    expect(screen.getByLabelText("App Control launch target").textContent).toBe(label);
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
