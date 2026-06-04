/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactNamespace from "react";
import type * as RouterNamespace from "react-router-dom";
import { ADE_OPEN_BUILT_IN_BROWSER_EVENT } from "../../lib/openExternal";

const workLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
}));

const lanesLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
}));

const appStoreState = vi.hoisted(() => ({
  projectHydrated: true,
  showWelcome: false,
  project: { rootPath: "/fake/project" },
  projectBinding: {
    kind: "local",
    key: "local:/fake/project",
    rootPath: "/fake/project",
    displayName: "project",
  } as {
    kind: "local" | "remote";
    key: string;
    rootPath: string;
    displayName: string;
    targetId?: string;
    runtimeName?: string;
    projectId?: string;
  },
  projectTransition: null as { kind: "opening" | "switching" | "closing"; rootPath: string | null; startedAtMs: number } | null,
  theme: "dark",
  launchPromptClipboardEnabled: true,
  launchPromptClipboardNoticeEnabled: true,
  workViewByProject: {} as Record<string, Record<string, unknown>>,
  setWorkViewState: vi.fn((projectRoot: string | null | undefined, next: Record<string, unknown>) => {
    if (!projectRoot) return;
    const current = appStoreState.workViewByProject[projectRoot] ?? {};
    appStoreState.workViewByProject[projectRoot] = { ...current, ...next };
  }),
  openProjectTabRoots: [] as string[],
  projectInfoByRoot: {} as Record<string, { rootPath: string; displayName?: string }>,
}));

vi.mock("../../state/appStore", async () => {
  const ReactModule = await vi.importActual("react") as typeof ReactNamespace;
  const createScopedState = (project = appStoreState.project) => ({
    ...appStoreState,
    project,
    lanes: [],
    lanesLoading: false,
    keybindings: null,
    refreshLanes: vi.fn(async () => undefined),
    refreshKeybindings: vi.fn(async () => undefined),
    refreshProviderMode: vi.fn(async () => undefined),
  });
  return {
    useAppStore: vi.fn((selector: (state: typeof appStoreState) => unknown) => selector(appStoreState)),
    createProjectAppStore: vi.fn((project, projectBinding) => {
      let state = {
        ...createScopedState(project),
        projectBinding: projectBinding ?? appStoreState.projectBinding,
      };
      return {
        getState: () => state,
        setState: (partial: unknown) => {
          state = {
            ...state,
            ...(typeof partial === "function" ? (partial as (prev: typeof state) => Partial<typeof state>)(state) : partial as Partial<typeof state>),
          };
        },
        subscribe: vi.fn(() => () => {}),
      };
    }),
    hydrateProjectAppStore: vi.fn((store, partial) => {
      store.setState(partial);
    }),
    AppStoreProvider: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

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
    TerminalsPage: ({ active = true }: { active?: boolean }) => {
      const navigate = Router.useNavigate();
      ReactModule.useEffect(() => {
        workLifecycle.mounts += 1;
        return () => {
          workLifecycle.unmounts += 1;
        };
      }, []);

      return (
        <div data-testid="work-page" data-active={active ? "true" : "false"}>
          <button type="button" onClick={() => navigate("/files")}>
            Open files
          </button>
        </div>
      );
    },
  };
});

vi.mock("../files/FilesTab", async () => {
  const Router = await vi.importActual("react-router-dom") as typeof RouterNamespace;

  return {
    FilesTab: () => {
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

vi.mock("../lanes/LanesPage", async () => {
  const ReactModule = await vi.importActual("react") as typeof ReactNamespace;
  const Router = await vi.importActual("react-router-dom") as typeof RouterNamespace;

  return {
    LanesPage: ({ active = true }: { active?: boolean }) => {
      const navigate = Router.useNavigate();
      ReactModule.useEffect(() => {
        lanesLifecycle.mounts += 1;
        return () => {
          lanesLifecycle.unmounts += 1;
        };
      }, []);

      return (
        <div data-testid="lanes-page" data-active={active ? "true" : "false"}>
          <button type="button" onClick={() => navigate("/files")}>
            Lanes open files
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
    lanesLifecycle.mounts = 0;
    lanesLifecycle.unmounts = 0;
    appStoreState.projectHydrated = true;
    appStoreState.showWelcome = false;
    appStoreState.project = { rootPath: "/fake/project" };
    appStoreState.projectBinding = {
      kind: "local",
      key: "local:/fake/project",
      rootPath: "/fake/project",
      displayName: "project",
    };
    appStoreState.projectTransition = null;
    appStoreState.theme = "dark";
    appStoreState.launchPromptClipboardEnabled = true;
    appStoreState.launchPromptClipboardNoticeEnabled = true;
    appStoreState.workViewByProject = {};
    appStoreState.setWorkViewState.mockClear();
    appStoreState.openProjectTabRoots = [];
    appStoreState.projectInfoByRoot = {};
    window.localStorage.clear();
    (window as Window & { __adeBrowserMock?: boolean }).__adeBrowserMock = true;
    window.history.replaceState({}, "", "/work");
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the Work page mounted while other ADE tabs are active", async () => {
    const { App } = await import("./App");

    render(<App />);

    const workPage = await screen.findByTestId("work-page");
    await waitFor(() => {
      expect(workLifecycle.mounts).toBe(1);
    });
    expect(workLifecycle.unmounts).toBe(0);
    expect(workPage.closest("[aria-hidden='true']")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open files" }));
    await screen.findByTestId("files-page");

    const parkedWorkSurface = screen.getByTestId("work-page").closest("[aria-hidden='true']");
    expect(parkedWorkSurface).not.toBeNull();
    expect(parkedWorkSurface?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("work-page").getAttribute("data-active")).toBe("false");
    expect(workLifecycle.mounts).toBe(1);
    expect(workLifecycle.unmounts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Open work" }));
    await waitFor(() => {
      expect(screen.getByTestId("work-page").closest("[aria-hidden='true']")).toBeNull();
      expect(screen.getByTestId("work-page").getAttribute("data-active")).toBe("true");
    });
    expect(workLifecycle.mounts).toBe(1);
    expect(workLifecycle.unmounts).toBe(0);
  });

  it("reveals the Work browser pane when an ADE browser URL opens from another tab", async () => {
    window.history.replaceState({}, "", "/files");
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("files-page");
    fireEvent(window, new CustomEvent(ADE_OPEN_BUILT_IN_BROWSER_EVENT, {
      detail: { url: "http://127.0.0.1:64054" },
    }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/work");
    });
    expect(appStoreState.setWorkViewState).toHaveBeenCalledWith(
      "/fake/project",
      expect.objectContaining({
        viewMode: "tabs",
        workSidebarOpen: true,
        workSidebarTab: "browser",
      }),
    );
  });

  it("hydrates project stores with launch clipboard reminder preferences", async () => {
    appStoreState.launchPromptClipboardNoticeEnabled = false;
    const { hydrateProjectAppStore } = await import("../../state/appStore");
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("work-page");
    await waitFor(() => {
      expect(hydrateProjectAppStore).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          launchPromptClipboardEnabled: true,
          launchPromptClipboardNoticeEnabled: false,
        }),
      );
    });
  });

  it("does not mount the Work page when hydration has not found a project yet", async () => {
    appStoreState.projectHydrated = false;
    appStoreState.project = { rootPath: "" };
    const { App } = await import("./App");

    render(<App />);

    expect(screen.queryByTestId("work-page")).toBeNull();
    expect(workLifecycle.mounts).toBe(0);
  });

  it("keeps the Work page mounted during a same-project hydration refresh", async () => {
    const { App } = await import("./App");

    const { rerender } = render(<App />);

    await screen.findByTestId("work-page");
    expect(workLifecycle.mounts).toBe(1);
    expect(workLifecycle.unmounts).toBe(0);

    appStoreState.projectHydrated = false;
    rerender(<App />);

    expect(screen.getByTestId("work-page")).toBeTruthy();
    expect(workLifecycle.mounts).toBe(1);
    expect(workLifecycle.unmounts).toBe(0);
  });

  it("redirects to /project when there is no active project on the Work route", async () => {
    appStoreState.project = { rootPath: "" };
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("project-page");
    expect(screen.queryByTestId("work-page")).toBeNull();
    expect(workLifecycle.mounts).toBe(0);
  });

  it("redirects to /project when the welcome flow is active on the Work route", async () => {
    appStoreState.showWelcome = true;
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("project-page");
    expect(screen.queryByTestId("work-page")).toBeNull();
    expect(workLifecycle.mounts).toBe(0);
  });

  it("enters the project surface instead of preserving the project picker route", async () => {
    window.history.replaceState({}, "", "/project");
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("work-page");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/work");
    });
    expect(screen.queryByTestId("project-page")).toBeNull();
  });

  it("does not render the Work surface on non-Work routes when the project is missing", async () => {
    appStoreState.project = { rootPath: "" };
    window.history.replaceState({}, "", "/files");
    const { App } = await import("./App");

    render(<App />);

    // The project host should route missing projects to the picker; the
    // inactive Work surface must NOT also navigate (would race) or mount Work.
    await screen.findByTestId("project-page");
    expect(screen.queryByTestId("work-page")).toBeNull();
    expect(workLifecycle.mounts).toBe(0);
  });

  it("unmounts the Lanes page after leaving so hidden lane panes do not keep doing work", async () => {
    window.history.replaceState({}, "", "/lanes");
    const { App } = await import("./App");

    render(<App />);

    const lanesPage = await screen.findByTestId("lanes-page");
    await waitFor(() => {
      expect(lanesLifecycle.mounts).toBe(1);
    });
    expect(lanesLifecycle.unmounts).toBe(0);
    expect(lanesPage.closest("[aria-hidden='true']")).toBeNull();
    expect(lanesPage.getAttribute("data-active")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Lanes open files" }));
    await screen.findByTestId("files-page");

    expect(screen.queryByTestId("lanes-page")).toBeNull();
    expect(lanesLifecycle.mounts).toBe(1);
    expect(lanesLifecycle.unmounts).toBe(1);
  });

  it("covers the old project surface while a cold project switch is pending", async () => {
    appStoreState.projectTransition = {
      kind: "switching",
      rootPath: "/other/project",
      startedAtMs: 123,
    };
    appStoreState.projectInfoByRoot = {
      "/other/project": { rootPath: "/other/project", displayName: "Other project" },
    };
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("work-page");
    expect(screen.getByTestId("project-transition-veil").textContent).toContain(
      "Switching to Other project...",
    );
  });

  it("does not mount the Lanes page while Work is active", async () => {
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("work-page");
    expect(screen.queryByTestId("lanes-page")).toBeNull();
    expect(lanesLifecycle.mounts).toBe(0);
    expect(lanesLifecycle.unmounts).toBe(0);
  });

  it("does not render inactive project Lanes surfaces against the active runtime", async () => {
    appStoreState.project = { rootPath: "/fake/project" };
    appStoreState.openProjectTabRoots = ["/fake/project", "/other/project"];
    appStoreState.projectInfoByRoot = {
      "/fake/project": { rootPath: "/fake/project", displayName: "Fake" },
      "/other/project": { rootPath: "/other/project", displayName: "Other" },
    };
    window.localStorage.setItem("ade:project-route:/other/project", "/lanes");
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("work-page");
    expect(screen.queryByTestId("lanes-page")).toBeNull();
    expect(lanesLifecycle.mounts).toBe(0);
    expect(lanesLifecycle.unmounts).toBe(0);
  });

  it("mounts the active remote project even when local project tabs are open", async () => {
    appStoreState.project = { rootPath: "/remote/project", displayName: "Remote project" } as any;
    appStoreState.projectBinding = {
      kind: "remote",
      key: "remote:studio:project-1",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "project-1",
      rootPath: "/remote/project",
      displayName: "Remote project",
    };
    appStoreState.openProjectTabRoots = ["/fake/project"];
    appStoreState.projectInfoByRoot = {
      "/fake/project": { rootPath: "/fake/project", displayName: "Fake" },
    };
    const { createProjectAppStore, hydrateProjectAppStore } = await import("../../state/appStore");
    const { App } = await import("./App");

    render(<App />);

    await waitFor(() => {
      const remoteSurface = screen
        .getAllByTestId("work-page")
        .find((node) => node.closest("[data-project-root='/remote/project']"));
      expect(remoteSurface).toBeTruthy();
      expect(remoteSurface?.closest("[aria-hidden='true']")).toBeNull();
      expect(remoteSurface?.getAttribute("data-active")).toBe("true");
    });
    expect(createProjectAppStore).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/remote/project" }),
      expect.objectContaining({
        kind: "remote",
        runtimeName: "Mac Studio",
        rootPath: "/remote/project",
      }),
    );
    await waitFor(() => {
      expect(hydrateProjectAppStore).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectBinding: expect.objectContaining({
            kind: "remote",
            runtimeName: "Mac Studio",
            rootPath: "/remote/project",
          }),
        }),
      );
    });

    const localSurface = screen
      .getAllByTestId("work-page")
      .find((node) => node.closest("[data-project-root='/fake/project']"));
    expect(localSurface?.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("converts legacy hash app routes into BrowserRouter paths", async () => {
    window.history.replaceState({}, "", "/work#/lanes");
    const { App } = await import("./App");

    render(<App />);

    await screen.findByTestId("lanes-page");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/lanes");
      expect(window.location.hash).toBe("");
    });
    expect(screen.getByTestId("work-page").getAttribute("data-active")).toBe("false");
  });
});
