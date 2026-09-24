/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/appStore";
import { ProjectTransitionErrorAlert } from "./ProjectTransitionErrorAlert";
import { AppBannerHost } from "../ui/notice";
import { resetAppBannersForTests } from "../ui/notice/appBannerStore";

function renderAlert() {
  return render(
    <>
      <ProjectTransitionErrorAlert />
      <AppBannerHost />
    </>,
  );
}

describe("ProjectTransitionErrorAlert", () => {
  beforeEach(() => {
    useAppStore.setState({
      projectTransition: null,
      projectTransitionError: null,
    });
  });

  afterEach(() => {
    cleanup();
    resetAppBannersForTests();
    vi.restoreAllMocks();
  });

  it("renders an un-coded string failure as a dismissible banner", () => {
    useAppStore.setState({
      projectTransitionError: {
        message: "Could not open the project.",
        detail: "some raw stack",
      },
    });

    renderAlert();

    expect(screen.getByRole("alert").textContent).toContain("Could not open the project.");
    expect(screen.getByTitle("Dismiss project error")).toBeTruthy();
  });

  it("defers to the full-screen recovery flow for coded failures", () => {
    useAppStore.setState({
      projectTransitionError: {
        code: "disk_full",
        message: "Your computer ran out of storage.",
        rootPath: "/tmp/recover-me",
      },
    });

    renderAlert();

    // Coded errors are owned by ProjectRecoveryScreen — no banner registers.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a coded failure without a project root as a dismissible banner", () => {
    useAppStore.setState({
      projectTransitionError: {
        code: "disk_full",
        message: "Your computer ran out of storage.",
      },
    });

    renderAlert();

    expect(screen.getByRole("alert").textContent).toContain("Your computer ran out of storage.");
    expect(screen.getByTitle("Dismiss project error")).toBeTruthy();
  });
});

describe("ProjectTransitionErrorAlert actions", () => {
  afterEach(() => {
    cleanup();
    resetAppBannersForTests();
    useAppStore.setState({ projectTransition: null, projectTransitionError: null });
  });

  it("retries the failed root and clears the error on Try again", () => {
    const switchProjectToPath = vi.fn(async () => undefined);
    const original = useAppStore.getState().switchProjectToPath;
    useAppStore.setState({
      projectTransition: null,
      projectTransitionError: { message: "Could not switch.", retryRootPath: "/tmp/p" },
      switchProjectToPath: switchProjectToPath as never,
    });

    renderAlert();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(switchProjectToPath).toHaveBeenCalledWith("/tmp/p");
    expect(useAppStore.getState().projectTransitionError).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    useAppStore.setState({ switchProjectToPath: original });
  });
});
