/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/appStore";
import { ProjectTransitionErrorAlert } from "./ProjectTransitionErrorAlert";

describe("ProjectTransitionErrorAlert", () => {
  beforeEach(() => {
    useAppStore.setState({
      projectTransition: null,
      projectTransitionError: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders an un-coded string failure as a dismissible banner", () => {
    useAppStore.setState({
      projectTransitionError: {
        message: "Could not open the project.",
        detail: "some raw stack",
      },
    });

    render(<ProjectTransitionErrorAlert />);

    expect(screen.getByRole("alert").textContent).toContain("Could not open the project.");
    expect(screen.getByRole("button", { name: "Dismiss project error" })).toBeTruthy();
  });

  it("defers to the full-screen recovery flow for coded failures", () => {
    useAppStore.setState({
      projectTransitionError: {
        code: "disk_full",
        message: "Your Mac ran out of storage.",
        rootPath: "/tmp/recover-me",
      },
    });

    const { container } = render(<ProjectTransitionErrorAlert />);

    // Coded errors are owned by ProjectRecoveryScreen — the banner renders nothing.
    expect(container.firstChild).toBeNull();
  });
});
