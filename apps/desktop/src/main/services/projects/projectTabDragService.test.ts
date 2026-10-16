import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenProjectBinding } from "../../../shared/types";
import { createProjectTabDragService } from "./projectTabDragService";

const electronMock = vi.hoisted(() => ({
  getAllWindows: vi.fn((): unknown[] => []),
  getFocusedWindow: vi.fn((): unknown => null),
  getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: electronMock.getAllWindows,
    getFocusedWindow: electronMock.getFocusedWindow,
  },
  screen: {
    getCursorScreenPoint: electronMock.getCursorScreenPoint,
  },
}));

type Rect = { x: number; y: number; width: number; height: number };

const LOCAL_BINDING: OpenProjectBinding = {
  kind: "local",
  key: "local:/Users/me/ADE",
  rootPath: "/Users/me/ADE",
  displayName: "ADE",
};

/**
 * A BrowserWindow stand-in that records what the service does to it. `on`/`once`
 * listeners are captured so a test can fire the real lifecycle events the
 * service watches for.
 */
function fakeWindow(args: { id: number; bounds?: Rect; contentBounds?: Rect; zoom?: number }) {
  const bounds = args.bounds ?? { x: 0, y: 0, width: 800, height: 600 };
  const contentBounds = args.contentBounds ?? bounds;
  const listeners = new Map<string, Array<(...parameters: unknown[]) => void>>();
  const position: [number, number] = [bounds.x, bounds.y];

  const register = (key: string, callback: (...parameters: unknown[]) => void) => {
    const list = listeners.get(key) ?? [];
    list.push(callback);
    listeners.set(key, list);
  };
  const unregister = (key: string, callback: (...parameters: unknown[]) => void) => {
    const list = listeners.get(key) ?? [];
    const index = list.indexOf(callback);
    if (index >= 0) list.splice(index, 1);
  };

  const win = {
    id: args.id,
    destroyed: false,
    visible: true,
    minimized: false,
    parent: null as unknown,
    fullScreen: false,
    maximized: false,
    setPosition: vi.fn((x: number, y: number) => {
      position[0] = x;
      position[1] = y;
    }),
    focus: vi.fn(),
    unmaximize: vi.fn(),
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    getParentWindow: () => win.parent,
    getBounds: () => ({ ...bounds }),
    getContentBounds: () => ({ ...contentBounds }),
    getNormalBounds: () => ({ ...bounds }),
    getPosition: () => [...position] as [number, number],
    isFullScreen: () => win.fullScreen,
    isMaximized: () => win.maximized,
    on: vi.fn(register),
    once: vi.fn(register),
    removeListener: vi.fn(unregister),
    emit: (event: string) => {
      for (const callback of [...(listeners.get(event) ?? [])]) callback();
    },
    webContents: {
      getZoomFactor: () => args.zoom ?? 1,
      isDestroyed: () => false,
      on: vi.fn((event: string, callback: (...parameters: unknown[]) => void) =>
        register(`web:${event}`, callback),
      ),
      once: vi.fn((event: string, callback: (...parameters: unknown[]) => void) =>
        register(`web:${event}`, callback),
      ),
      removeListener: vi.fn((event: string, callback: (...parameters: unknown[]) => void) =>
        unregister(`web:${event}`, callback),
      ),
    },
  };
  return win;
}

function makeService(overrides: {
  openWindow?: ReturnType<typeof vi.fn>;
  sanitizeBinding?: ReturnType<typeof vi.fn>;
} = {}) {
  const openWindow = overrides.openWindow ?? vi.fn();
  const closeWindow = vi.fn();
  const sendAdopt = vi.fn();
  const sanitizeBinding = overrides.sanitizeBinding ?? vi.fn((value: unknown) => value as OpenProjectBinding);
  const service = createProjectTabDragService({
    sanitizeBinding: sanitizeBinding as (value: unknown) => OpenProjectBinding | null,
    openWindow: openWindow as never,
    closeWindow,
    sendAdopt,
  });
  return { service, openWindow, closeWindow, sendAdopt, sanitizeBinding };
}

describe("projectTabDragService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electronMock.getAllWindows.mockReset();
    electronMock.getAllWindows.mockReturnValue([]);
    electronMock.getFocusedWindow.mockReset();
    electronMock.getFocusedWindow.mockReturnValue(null);
    electronMock.getCursorScreenPoint.mockReset();
    electronMock.getCursorScreenPoint.mockReturnValue({ x: 0, y: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows the pointer with the dragged window and does not merge without a drop target", async () => {
    const source = fakeWindow({ id: 1 });
    const dragged = fakeWindow({ id: 2 });
    const openWindow = vi.fn(async ({ onWindow }: { onWindow: (win: unknown) => void }) => {
      onWindow(dragged);
      return dragged;
    });
    const { service, closeWindow, sendAdopt } = makeService({ openWindow });
    // Only the source window exists under the release point, far below the header.
    electronMock.getAllWindows.mockReturnValue([source]);

    const started = await service.start({
      source: source as never,
      binding: LOCAL_BINDING,
      grab: { x: 10, y: 10 },
      moveSource: false,
      point: { x: 100, y: 100 },
    });
    expect(started).toEqual({ windowId: 2 });

    service.move({ x: 140, y: 150 });
    vi.advanceTimersByTime(8);
    expect(dragged.setPosition).toHaveBeenCalledWith(130, 140);

    const ended = service.end({ x: 140, y: 300 });
    expect(ended).toEqual({ merged: false, targetWindowId: null });
    expect(sendAdopt).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
    expect(dragged.focus).toHaveBeenCalled();
  });

  it("adopts the project into the window under the pointer and closes the dragged window", async () => {
    const source = fakeWindow({ id: 1 });
    const dragged = fakeWindow({ id: 2 });
    const target = fakeWindow({ id: 3, bounds: { x: 0, y: 0, width: 1_200, height: 800 } });
    const openWindow = vi.fn(async ({ onWindow }: { onWindow: (win: unknown) => void }) => {
      onWindow(dragged);
      return dragged;
    });
    const { service, closeWindow, sendAdopt } = makeService({ openWindow });
    electronMock.getAllWindows.mockReturnValue([source, target]);
    electronMock.getFocusedWindow.mockReturnValue(target);

    await service.start({
      source: source as never,
      binding: LOCAL_BINDING,
      grab: { x: 10, y: 10 },
      moveSource: false,
      point: { x: 100, y: 100 },
    });
    // y=20 is inside the target's header band; x=200 is the drop offset.
    const ended = service.end({ x: 200, y: 20 });

    expect(ended).toEqual({ merged: true, targetWindowId: 3 });
    expect(sendAdopt).toHaveBeenCalledWith(target, {
      binding: LOCAL_BINDING,
      screenOffsetX: 200,
    });
    expect(closeWindow).toHaveBeenCalledWith(dragged);
    expect(target.focus).toHaveBeenCalled();
  });

  it("moves the source window itself when the tab was the window's only tab", async () => {
    const source = fakeWindow({ id: 7, bounds: { x: 50, y: 50, width: 800, height: 600 } });
    const openWindow = vi.fn();
    const { service } = makeService({ openWindow });

    const started = await service.start({
      source: source as never,
      binding: LOCAL_BINDING,
      grab: { x: 5, y: 5 },
      moveSource: true,
      point: { x: 100, y: 100 },
    });

    expect(started).toEqual({ windowId: 7 });
    expect(openWindow).not.toHaveBeenCalled();

    service.move({ x: 200, y: 220 });
    vi.advanceTimersByTime(8);
    expect(source.setPosition).toHaveBeenCalledWith(195, 215);
  });

  it("stops following when the source window is closed mid-drag", async () => {
    const source = fakeWindow({ id: 1 });
    const dragged = fakeWindow({ id: 2 });
    const openWindow = vi.fn(async ({ onWindow }: { onWindow: (win: unknown) => void }) => {
      onWindow(dragged);
      return dragged;
    });
    const { service } = makeService({ openWindow });

    await service.start({
      source: source as never,
      binding: LOCAL_BINDING,
      grab: { x: 10, y: 10 },
      moveSource: false,
      point: { x: 100, y: 100 },
    });
    service.move({ x: 140, y: 150 });
    vi.advanceTimersByTime(8);
    expect(dragged.setPosition).toHaveBeenCalledTimes(1);

    source.emit("closed");
    dragged.setPosition.mockClear();
    vi.advanceTimersByTime(64);
    expect(dragged.setPosition).not.toHaveBeenCalled();
  });

  it("does not start following when the drag ended before the new window opened", async () => {
    const dragged = fakeWindow({ id: 9 });
    let finishOpen: ((win: unknown) => void) | null = null;
    const openWindow = vi.fn(
      ({ onWindow }: { onWindow: (win: unknown) => void }) =>
        new Promise((resolve) => {
          finishOpen = (win) => {
            onWindow(win);
            resolve(win);
          };
        }),
    );
    const { service } = makeService({ openWindow });
    const source = fakeWindow({ id: 1 });

    const started = service.start({
      source: source as never,
      binding: LOCAL_BINDING,
      grab: { x: 1, y: 1 },
      moveSource: false,
      point: { x: 10, y: 10 },
    });
    // The release lands before the window exists.
    service.end(null);
    finishOpen!(dragged);

    const resolved = await started;
    expect(resolved).toEqual({ windowId: 9 });
    vi.advanceTimersByTime(64);
    expect(dragged.setPosition).not.toHaveBeenCalled();
  });

  it("never merges a cancelled drag", async () => {
    const source = fakeWindow({ id: 1 });
    const dragged = fakeWindow({ id: 2 });
    const target = fakeWindow({ id: 3, bounds: { x: 0, y: 0, width: 1_200, height: 800 } });
    const openWindow = vi.fn(async ({ onWindow }: { onWindow: (win: unknown) => void }) => {
      onWindow(dragged);
      return dragged;
    });
    const { service, closeWindow, sendAdopt } = makeService({ openWindow });
    electronMock.getAllWindows.mockReturnValue([source, target]);
    electronMock.getFocusedWindow.mockReturnValue(target);

    await service.start({
      source: source as never,
      binding: LOCAL_BINDING,
      grab: { x: 10, y: 10 },
      moveSource: false,
      point: { x: 100, y: 100 },
    });
    const ended = service.end({ x: 200, y: 20 }, { cancelled: true });

    expect(ended).toEqual({ merged: false, targetWindowId: null });
    expect(sendAdopt).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("refuses a renderer binding that does not sanitize", async () => {
    const sanitizeBinding = vi.fn(() => null);
    const openWindow = vi.fn();
    const { service } = makeService({ openWindow, sanitizeBinding });

    const started = await service.start({
      source: fakeWindow({ id: 1 }) as never,
      binding: { kind: "local" },
      grab: { x: 0, y: 0 },
      moveSource: false,
      point: null,
    });

    expect(started).toEqual({ windowId: null });
    expect(openWindow).not.toHaveBeenCalled();
  });
});
