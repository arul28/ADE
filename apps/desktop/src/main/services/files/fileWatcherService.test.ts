import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChangeEvent } from "../../../shared/types";

const chokidarState = vi.hoisted(() => {
  const watchers: Array<{
    handlers: Map<string, (absPath: string) => void>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const watchMock = vi.fn((_rootPath: string, _options: unknown) => {
    const handlers = new Map<string, (absPath: string) => void>();
    const close = vi.fn(async () => undefined);
    const watcher: {
      on: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    } = {
      on: vi.fn((event: string, cb: (absPath: string) => void) => {
        handlers.set(event, cb);
        return watcher;
      }),
      close,
    };
    watchers.push({ handlers, close });
    return watcher;
  });
  return { watchMock, watchers };
});

vi.mock("chokidar", () => ({
  default: {
    watch: chokidarState.watchMock,
  },
}));

import { createFileWatcherService } from "./fileWatcherService";

describe("fileWatcherService", () => {
  beforeEach(() => {
    chokidarState.watchMock.mockClear();
    chokidarState.watchers.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps node_modules filtered even when includeIgnored is requested", () => {
    const service = createFileWatcherService();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.watch({ workspaceId: "ws-2", rootPath: "/repo", senderId: 2, includeIgnored: true }, vi.fn());

    const defaultIgnored = chokidarState.watchMock.mock.calls[0]?.[1] as { ignored: RegExp[] };
    const includeIgnored = chokidarState.watchMock.mock.calls[1]?.[1] as { ignored: RegExp[] };

    expect(defaultIgnored.ignored.map((pattern) => String(pattern))).toEqual([
      "/(^|[/\\\\])\\.git($|[/\\\\])/",
      "/(^|[/\\\\])node_modules($|[/\\\\])/",
      "/(^|[/\\\\])\\.ade($|[/\\\\])/",
    ]);
    expect(includeIgnored.ignored.map((pattern) => String(pattern))).toEqual([
      "/(^|[/\\\\])\\.git($|[/\\\\])/",
      "/(^|[/\\\\])node_modules($|[/\\\\])/",
    ]);
  });

  it("forwards ignored-path events when includeIgnored is true but still filters .git", () => {
    const service = createFileWatcherService();
    const callback = vi.fn();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1, includeIgnored: true }, callback);
    const handlers = chokidarState.watchers[0]?.handlers;
    expect(handlers).toBeTruthy();

    handlers?.get("add")?.("/repo/.ade/context/PRD.ade.md");
    handlers?.get("change")?.("/repo/.git/config");
    vi.runAllTimers();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      type: "created",
      path: ".ade/context/PRD.ade.md",
      ts: expect.any(String),
    });
  });

  it("continues filtering .ade events when includeIgnored is not enabled", () => {
    const service = createFileWatcherService();
    const callback = vi.fn();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, callback);
    const handlers = chokidarState.watchers[0]?.handlers;
    expect(handlers).toBeTruthy();

    handlers?.get("add")?.("/repo/.ade/context/PRD.ade.md");
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
  });

  it("reference-counts watchers for the same sender and workspace", () => {
    const service = createFileWatcherService();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());

    expect(chokidarState.watchMock).toHaveBeenCalledTimes(1);
    service.stop("ws-1", 1, false);
    expect(chokidarState.watchers[0]?.close).not.toHaveBeenCalled();
    service.stop("ws-1", 1, false);
    expect(chokidarState.watchers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("upgrades and downgrades includeIgnored mode without dropping active watchers", () => {
    const service = createFileWatcherService();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1, includeIgnored: true }, vi.fn());

    expect(chokidarState.watchMock).toHaveBeenCalledTimes(2);
    expect(chokidarState.watchers[0]?.close).toHaveBeenCalledTimes(1);

    service.stop("ws-1", 1, false);
    expect(chokidarState.watchers[1]?.close).not.toHaveBeenCalled();

    service.stop("ws-1", 1, true);
    expect(chokidarState.watchers[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("stops both default and includeIgnored subscriptions when a sender disconnects", () => {
    const service = createFileWatcherService();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1, includeIgnored: true }, vi.fn());
    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1, includeIgnored: true }, vi.fn());

    expect(chokidarState.watchMock).toHaveBeenCalledTimes(2);

    service.stopAllForSender(1);

    expect(chokidarState.watchers[1]?.close).toHaveBeenCalledTimes(1);
  });
});
