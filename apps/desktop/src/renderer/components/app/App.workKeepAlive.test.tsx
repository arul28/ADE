/* @vitest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactNamespace from "react";
import type * as RouterNamespace from "react-router-dom";

const workLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
}));

const appStoreState = vi.hoisted(() => ({
  projectHydrated: true,
  showWelcome: false,
  project: { rootPath: "/fake/project" },
  theme: "dark",
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: vi.fn((selector: (state: typeof appStoreState) => unknown) => selector(appStoreState)),
}));

vi.mock("../../lib/debugLog", () => ({
  logRendererDebugEvent: vi.fn(),
}));

vi.mock("../../lib/dirtyWorkspaceBuffers", () => ({
  getDirtyFileTextForWindow: vi.fn(),
}));

vi.mock("./AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock("../onboarding/OnboardingBootstrap", () => ({
  OnboardingBootstrap: () => null,
}));

vi.mock("../run/RunPage", () => ({
  RunPage: () => <div data-testid="project-page" />,
}));

vi.mock("../onboarding/ProjectSetupPage", () => ({
  ProjectSetupPage: () => <div data-testid="onboarding-page" />,
}));

vi.mock("../onboarding/GlossaryPage", () => ({
  GlossaryPage: () => <div data-testid="glossary-page" />,
}));

vi.mock("../terminals/TerminalsPage", async () => {
  const ReactModule = await vi.importActual("react") as typeof ReactNamespace;
  const Router = await vi.importActual("react-router-dom") as typeof RouterNamespace;

  return {
    TerminalsPage: () => {
      const navigate = Router.useNavigate();
      ReactModule.useEffect(() => {
        workLifecycle.mounts += 1;
        return () => {
          workLifecycle.unmounts += 1;
        };
      }, []);

      return (
        <div data-testid="work-page">
          <button type="button" onClick={() => navigate("/files")}>
            Open files
          </button>
        </div>
      );
    },
  };
});

vi.mock("../files/FilesPage", async () => {
  const Router = await vi.importActual("react-router-dom") as typeof RouterNamespace;

  return {
    FilesPage: () => {
      const navigate = Router.useNavigate();
      return (
        <div data-testid="files-page">
          <button type="button" onClick={() => navigate("/work")}>
            Open work
          </button>
        </div>
      );
    },
  };
});

describe("App Work route keep-alive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workLifecycle.mounts = 0;
    workLifecycle.unmounts = 0;
    appStoreState.projectHydrated = true;
    appStoreState.showWelcome = false;
    appStoreState.project = { rootPath: "/fake/project" };
    appStoreState.theme = "dark";
    (window as Window & { __adeBrowserMock?: boolean }).__adeBrowserMock = true;
    window.history.replaceState({}, "", "/work");
  });

  it("keeps the Work page mounted while other ADE tabs are active", async () => {
    const { App } = await import("./App");

    render(<App />);

    const workPage = await screen.findByTestId("work-page");
    await waitFor(() => {
      expect(workLifecycle.mounts).toBe(1);
    });
    expect(workLifecycle.unmounts).toBe(0);
    expect(workPage.closest("[hidden]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open files" }));
    await screen.findByTestId("files-page");

    expect(screen.getByTestId("work-page").closest("[hidden]")).not.toBeNull();
    expect(workLifecycle.mounts).toBe(1);
    expect(workLifecycle.unmounts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Open work" }));
    await waitFor(() => {
      expect(screen.getByTestId("work-page").closest("[hidden]")).toBeNull();
    });
    expect(workLifecycle.mounts).toBe(1);
    expect(workLifecycle.unmounts).toBe(0);
  });
});
