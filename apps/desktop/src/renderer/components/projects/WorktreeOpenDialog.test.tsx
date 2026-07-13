// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ProjectPathInspection } from "../../../shared/types";
import { WorktreeOpenDialog } from "./WorktreeOpenDialog";
import { useAppStore } from "../../state/appStore";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigateSpy };
});

const attach = vi.fn();
const inspectPath = vi.fn();
const openExternal = vi.fn();
const switchToPath = vi.fn(async () => null);
const switchProjectToPath = vi.fn(async () => {});

beforeEach(() => {
  navigateSpy.mockReset();
  attach.mockReset();
  inspectPath.mockReset();
  openExternal.mockReset();
  switchProjectToPath.mockReset();
  switchProjectToPath.mockResolvedValue(undefined);
  (globalThis as any).window.ade = {
    project: { inspectPath, switchToPath },
    lanes: { attach },
    app: { openExternal },
  };
  useAppStore.setState({
    switchProjectToPath: switchProjectToPath as any,
    dismissWorktreeOpenPrompt: () =>
      useAppStore.setState({ worktreeOpenPrompt: null } as any),
    worktreeOpenPrompt: null,
  } as any);
});

afterEach(() => {
  cleanup();
});

function seed(inspection: ProjectPathInspection) {
  useAppStore.setState({ worktreeOpenPrompt: { inspection } } as any);
}

function renderDialog() {
  return render(
    <MemoryRouter>
      <WorktreeOpenDialog />
    </MemoryRouter>,
  );
}

const WORKTREE_ROOT = "/repos/app-feature";

function baseInspection(
  overrides: Partial<ProjectPathInspection> = {},
): ProjectPathInspection {
  return {
    inputPath: WORKTREE_ROOT,
    worktreeRoot: WORKTREE_ROOT,
    kind: "linked-worktree",
    branchRef: "feature/x",
    parent: {
      rootPath: "/repos/app",
      displayName: "app",
      isKnownAdeProject: true,
      existingLane: null,
    },
    standaloneState: null,
    ...overrides,
  };
}

describe("WorktreeOpenDialog", () => {
  it("variant A: renders the existing lane card and navigates to it", async () => {
    seed(
      baseInspection({
        parent: {
          rootPath: "/repos/app",
          displayName: "app",
          isKnownAdeProject: true,
          existingLane: {
            id: "lane-99",
            name: "feature x",
            branchRef: "feature/x",
            color: "#A78BFA",
            laneType: "attached",
          },
        },
      }),
    );
    renderDialog();

    expect(screen.getByText("Already open in app")).toBeTruthy();
    fireEvent.click(screen.getByText("Open this lane in app"));

    await waitFor(() =>
      expect(switchProjectToPath).toHaveBeenCalledWith("/repos/app", {
        skipWorktreeGate: true,
      }),
    );
    expect(attach).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-99&focus=single",
      ),
    );
  });

  it("variant B: attaches the worktree with the derived name then navigates", async () => {
    attach.mockResolvedValueOnce({ id: "lane-new" });
    seed(baseInspection());
    renderDialog();

    fireEvent.click(screen.getByText("Open as a lane in app"));

    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith({
        name: "feature/x",
        attachedPath: WORKTREE_ROOT,
      }),
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-new&focus=single",
      ),
    );
  });

  it("escape hatch: opens standalone via switchProjectToPath with skip flag", async () => {
    seed(baseInspection());
    renderDialog();

    fireEvent.click(
      screen.getByText("Open as a separate project instead ›"),
    );

    await waitFor(() =>
      expect(switchProjectToPath).toHaveBeenCalledWith(WORKTREE_ROOT, {
        skipWorktreeGate: true,
      }),
    );
    expect(attach).not.toHaveBeenCalled();
  });

  it("attach failure shows an inline error and keeps the dialog open", async () => {
    attach.mockRejectedValueOnce(new Error("something broke"));
    seed(baseInspection());
    renderDialog();

    fireEvent.click(screen.getByText("Open as a lane in app"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("something broke");
    // Dialog stays open, no navigation.
    expect(screen.getByText("Open as a lane in app")).toBeTruthy();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("already-linked attach error re-inspects and jumps to the existing lane", async () => {
    attach.mockRejectedValueOnce(
      new Error("This worktree is already linked as lane 'feature x'."),
    );
    inspectPath.mockResolvedValueOnce(
      baseInspection({
        parent: {
          rootPath: "/repos/app",
          displayName: "app",
          isKnownAdeProject: true,
          existingLane: {
            id: "lane-existing",
            name: "feature x",
            branchRef: "feature/x",
            color: null,
            laneType: "attached",
          },
        },
      }),
    );
    seed(baseInspection());
    renderDialog();

    fireEvent.click(screen.getByText("Open as a lane in app"));

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-existing&focus=single",
      ),
    );
  });
});
