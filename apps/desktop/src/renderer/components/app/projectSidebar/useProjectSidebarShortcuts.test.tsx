/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { getProjectSidebarPrefs, setProjectSidebarHidden } from "./projectSidebarPrefs";
import { useProjectSidebarShortcuts } from "./useProjectSidebarShortcuts";

const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? { metaKey: true } : { ctrlKey: true };

function Harness({ enabled = true, navigate }: { enabled?: boolean; navigate: (path: string) => void }) {
  useProjectSidebarShortcuts({ enabled, projectRoot: "/repo", keybindings: null, navigate });
  return (
    <div>
      <input aria-label="field" />
      <div className="xterm">
        <textarea aria-label="terminal" />
      </div>
    </div>
  );
}

describe("useProjectSidebarShortcuts", () => {
  afterEach(() => {
    cleanup();
    setProjectSidebarHidden(false);
    window.localStorage.clear();
  });

  it("opens the five tabs with Mod+1..5 and toggles the sidebar with Mod+B", () => {
    const navigate = vi.fn();
    render(<Harness navigate={navigate} />);

    for (const [key, path] of [["1", "/work"], ["2", "/lanes"], ["3", "/files"], ["4", "/prs"], ["5", "/automations"]]) {
      fireEvent.keyDown(window, { key, ...mod });
      expect(navigate).toHaveBeenLastCalledWith(path);
    }
    expect(navigate).toHaveBeenCalledTimes(5);

    fireEvent.keyDown(window, { key: "b", ...mod });
    expect(getProjectSidebarPrefs().hidden).toBe(true);
    fireEvent.keyDown(window, { key: "b", ...mod });
    expect(getProjectSidebarPrefs().hidden).toBe(false);
  });

  it("ignores bare digits, repeats, and chords another handler already used", () => {
    const navigate = vi.fn();
    const { getByLabelText } = render(<Harness navigate={navigate} />);

    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "2", repeat: true, ...mod });
    const field = getByLabelText("field");
    field.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(field, { key: "b", ...mod });

    expect(navigate).not.toHaveBeenCalled();
    expect(getProjectSidebarPrefs().hidden).toBe(false);
  });

  it("works from a text field, like the command palette", () => {
    const navigate = vi.fn();
    const { getByLabelText } = render(<Harness navigate={navigate} />);

    fireEvent.keyDown(getByLabelText("field"), { key: "3", ...mod });

    expect(navigate).toHaveBeenCalledWith("/files");
  });

  it("leaves Ctrl chords to the terminal off macOS", () => {
    const navigate = vi.fn();
    const { getByLabelText } = render(<Harness navigate={navigate} />);

    fireEvent.keyDown(getByLabelText("terminal"), { key: "b", ...mod });

    expect(getProjectSidebarPrefs().hidden).toBe(isMac);
  });

  it("does nothing while disabled", () => {
    const navigate = vi.fn();
    render(<Harness enabled={false} navigate={navigate} />);

    fireEvent.keyDown(window, { key: "1", ...mod });
    fireEvent.keyDown(window, { key: "b", ...mod });

    expect(navigate).not.toHaveBeenCalled();
    expect(getProjectSidebarPrefs().hidden).toBe(false);
  });
});
