import { describe, expect, it } from "vitest";

import {
  selectRemoteHostWindow,
  selectWindowForProjectNavigation,
  type ProjectNavigationWindowSnapshot,
  type RemoteHostWindowSnapshot,
} from "./projectNavigationWindowSelection";

const localWindow = (
  id: number,
  overrides: Partial<ProjectNavigationWindowSnapshot> = {},
): ProjectNavigationWindowSnapshot => ({
  id,
  activeProjectRoot: null,
  openProjectRoots: new Set<string>(),
  ...overrides,
});

const remoteWindow = (
  id: number,
  overrides: Partial<RemoteHostWindowSnapshot> = {},
): RemoteHostWindowSnapshot => ({
  id,
  hasRemoteBinding: false,
  activeProjectRoot: null,
  openProjectRoots: new Set<string>(),
  focused: false,
  ...overrides,
});

describe("selectWindowForProjectNavigation", () => {
  it("delivers to the window already showing the project without re-binding it", () => {
    // Re-activating a project that is already active would emit a redundant
    // project-changed round trip and reset the renderer's view state.
    expect(selectWindowForProjectNavigation("/projects/beta", [
      localWindow(1, { activeProjectRoot: "/projects/alpha" }),
      localWindow(2, {
        activeProjectRoot: "/projects/beta",
        openProjectRoots: new Set(["/projects/beta"]),
      }),
    ])).toEqual({ windowId: 2, activateProjectRoot: false });
  });

  it("activates an existing background tab rather than opening a second window", () => {
    expect(selectWindowForProjectNavigation("/projects/beta", [
      localWindow(1, {
        activeProjectRoot: "/projects/alpha",
        openProjectRoots: new Set(["/projects/alpha", "/projects/beta"]),
      }),
    ])).toEqual({ windowId: 1, activateProjectRoot: true });
  });

  it("prefers the window where the project is active over one holding it as a tab", () => {
    // Otherwise a deeplink could pull the project into a second window that
    // merely had it open in the background.
    expect(selectWindowForProjectNavigation("/projects/beta", [
      localWindow(1, { openProjectRoots: new Set(["/projects/beta"]) }),
      localWindow(2, { activeProjectRoot: "/projects/beta" }),
    ])).toEqual({ windowId: 2, activateProjectRoot: false });
  });

  it("asks the caller to open a window when no window knows the project", () => {
    expect(selectWindowForProjectNavigation("/projects/beta", [
      localWindow(1, {
        activeProjectRoot: "/projects/alpha",
        openProjectRoots: new Set(["/projects/alpha"]),
      }),
      localWindow(2),
    ])).toBeNull();
    expect(selectWindowForProjectNavigation("/projects/beta", [])).toBeNull();
  });

  it("never treats a project-less window as a match for an empty root", () => {
    // `null` (no project) and `""` (a root that normalized to nothing) are not
    // the same thing; conflating them would hand navigation to an empty window
    // and silently drop the destination.
    expect(selectWindowForProjectNavigation("", [localWindow(1)])).toBeNull();
  });
});

/**
 * The rule the deeplink/Activity feature depends on: opening a remote project
 * must never rebind the window the user is working in. Binding replaces that
 * window's global project context, so clicking a notification about another
 * machine used to throw away whatever the user had open.
 */
describe("selectRemoteHostWindow", () => {
  it("never hands a deeplink the window the user is working in", () => {
    expect(selectRemoteHostWindow([
      remoteWindow(1, { focused: true, activeProjectRoot: "/projects/mine" }),
    ])).toBeNull();
    expect(selectRemoteHostWindow([
      remoteWindow(1, { focused: true, openProjectRoots: new Set(["/projects/mine"]) }),
    ])).toBeNull();
    expect(selectRemoteHostWindow([
      remoteWindow(1, { focused: true, hasRemoteBinding: true }),
    ])).toBeNull();
  });

  it("refuses a window bound to another machine's project even when it looks empty", () => {
    // A remote binding carries no local project root, so the binding flag is the
    // only evidence that the window is occupied.
    expect(selectRemoteHostWindow([remoteWindow(1, { hasRemoteBinding: true })])).toBeNull();
  });

  it("prefers a focused empty window over any other empty window", () => {
    // Nothing to lose, and the user is already looking at it.
    expect(selectRemoteHostWindow([
      remoteWindow(1, { activeProjectRoot: "/projects/mine" }),
      remoteWindow(2),
      remoteWindow(3, { focused: true }),
    ])).toBe(3);
  });

  it("reuses any other empty window when the focused one holds a project", () => {
    expect(selectRemoteHostWindow([
      remoteWindow(1, { focused: true, activeProjectRoot: "/projects/mine" }),
      remoteWindow(2),
      remoteWindow(3),
    ])).toBe(2);
  });

  it("asks for a new window when every window holds a project", () => {
    expect(selectRemoteHostWindow([
      remoteWindow(1, { focused: true, activeProjectRoot: "/projects/mine" }),
      remoteWindow(2, { hasRemoteBinding: true }),
      remoteWindow(3, { openProjectRoots: new Set(["/projects/other"]) }),
    ])).toBeNull();
  });

  it("asks for a new window when there are no windows at all", () => {
    expect(selectRemoteHostWindow([])).toBeNull();
  });
});
