// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPathInspection } from "../../shared/types";

// ---------------------------------------------------------------------------
// window.ade / localStorage must exist before the store module is imported.
// ---------------------------------------------------------------------------
const inspectPath = vi.fn<[string], Promise<ProjectPathInspection>>();
const switchToPath = vi.fn<[string], Promise<unknown>>();

(globalThis as any).window = globalThis.window ?? {};
Object.assign((globalThis as any).window, {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  ade: {
    app: { getProject: vi.fn(async () => null) },
    lanes: { list: vi.fn(async () => []), listSnapshots: vi.fn(async () => []) },
    projectConfig: { get: vi.fn(async () => ({ effective: {} })) },
    ai: { getStatus: vi.fn(async () => null) },
    keybindings: { get: vi.fn(async () => null) },
    project: {
      openRepo: vi.fn(async () => null),
      listRecent: vi.fn(async () => []),
      switchToPath,
      inspectPath,
      closeCurrent: vi.fn(async () => {}),
    },
  },
});

import { useAppStore } from "./appStore";

const PARENT = {
  rootPath: "/repos/app",
  displayName: "app",
  isKnownAdeProject: true,
  existingLane: null,
};

function linkedWorktree(): ProjectPathInspection {
  return {
    inputPath: "/repos/app-feature",
    worktreeRoot: "/repos/app-feature",
    kind: "linked-worktree",
    branchRef: "feature/x",
    parent: PARENT,
    standaloneState: null,
  };
}

describe("appStore worktree open gate", () => {
  beforeEach(() => {
    inspectPath.mockReset();
    switchToPath.mockReset();
    switchToPath.mockImplementation(async (rootPath: string) => ({
      rootPath,
      displayName: "Project",
      baseRef: "main",
    }));
    useAppStore.setState({
      worktreeOpenPrompt: null,
      openProjectTabRoots: [],
      project: null,
      projectBinding: null,
    } as any);
  });

  it("surfaces the prompt for a linked worktree with a resolvable parent and does not open", async () => {
    inspectPath.mockResolvedValueOnce(linkedWorktree());

    await useAppStore.getState().switchProjectToPath("/repos/app-feature");

    expect(inspectPath).toHaveBeenCalledWith("/repos/app-feature");
    expect(switchToPath).not.toHaveBeenCalled();
    const prompt = useAppStore.getState().worktreeOpenPrompt;
    expect(prompt?.inspection.kind).toBe("linked-worktree");
    expect(prompt?.inspection.parent?.displayName).toBe("app");
  });

  it("does NOT prompt when the parent is unresolvable (opens standalone)", async () => {
    inspectPath.mockResolvedValueOnce({
      ...linkedWorktree(),
      parent: null,
    });

    await useAppStore.getState().switchProjectToPath("/repos/app-feature");

    expect(switchToPath).toHaveBeenCalledWith("/repos/app-feature");
    expect(useAppStore.getState().worktreeOpenPrompt).toBeNull();
  });

  it("bypasses the gate when skipWorktreeGate is set", async () => {
    inspectPath.mockResolvedValueOnce(linkedWorktree());

    await useAppStore
      .getState()
      .switchProjectToPath("/repos/app-feature", { skipWorktreeGate: true });

    expect(inspectPath).not.toHaveBeenCalled();
    expect(switchToPath).toHaveBeenCalledWith("/repos/app-feature");
    expect(useAppStore.getState().worktreeOpenPrompt).toBeNull();
  });

  it("bypasses the gate for a warm tab already open", async () => {
    useAppStore.setState({ openProjectTabRoots: ["/repos/app-feature"] } as any);
    inspectPath.mockResolvedValueOnce(linkedWorktree());

    await useAppStore.getState().switchProjectToPath("/repos/app-feature");

    expect(inspectPath).not.toHaveBeenCalled();
    expect(switchToPath).toHaveBeenCalledWith("/repos/app-feature");
  });

  it("falls through to a normal open when inspectPath rejects", async () => {
    inspectPath.mockRejectedValueOnce(new Error("inspect failed"));

    await useAppStore.getState().switchProjectToPath("/repos/whatever");

    expect(switchToPath).toHaveBeenCalledWith("/repos/whatever");
    expect(useAppStore.getState().worktreeOpenPrompt).toBeNull();
  });

  it("opens normally for a plain repo root (no prompt)", async () => {
    inspectPath.mockResolvedValueOnce({
      inputPath: "/repos/plain",
      worktreeRoot: "/repos/plain",
      kind: "repo-root",
      branchRef: "main",
      parent: null,
      standaloneState: null,
    });

    await useAppStore.getState().switchProjectToPath("/repos/plain");

    expect(switchToPath).toHaveBeenCalledWith("/repos/plain");
    expect(useAppStore.getState().worktreeOpenPrompt).toBeNull();
  });

  it("dismissWorktreeOpenPrompt clears the prompt", () => {
    useAppStore.setState({
      worktreeOpenPrompt: { inspection: linkedWorktree() },
    } as any);
    useAppStore.getState().dismissWorktreeOpenPrompt();
    expect(useAppStore.getState().worktreeOpenPrompt).toBeNull();
  });
});
