import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chokidarState = vi.hoisted(() => {
  const watchers: Array<{
    handlers: Map<string, (...args: unknown[]) => void>;
    emitReady: () => void;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  let autoReady = true;
  const watchMock = vi.fn((_rootPath: string, _options: unknown) => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const close = vi.fn(async () => undefined);
    let readyHandler: (() => void) | null = null;
    const watcher: {
      on: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    } = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers.set(event, cb);
        return watcher;
      }),
      once: vi.fn((event: string, cb: () => void) => {
        if (event === "ready") {
          readyHandler = cb;
          if (autoReady) cb();
        }
        return watcher;
      }),
      close,
    };
    watchers.push({
      handlers,
      emitReady: () => {
        readyHandler?.();
      },
      close,
    });
    return watcher;
  });
  return {
    watchMock,
    watchers,
    setAutoReady(value: boolean) {
      autoReady = value;
    },
  };
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
    chokidarState.setAutoReady(true);
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

    handlers?.get("add")?.("/repo/.ade/notes/project.md");
    handlers?.get("change")?.("/repo/.git/config");
    vi.runAllTimers();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      type: "created",
      path: ".ade/notes/project.md",
      ts: expect.any(String),
    });
  });

  it("suppresses volatile .ade runtime events even when includeIgnored is true", () => {
    const service = createFileWatcherService();
    const callback = vi.fn();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1, includeIgnored: true }, callback);
    const handlers = chokidarState.watchers[0]?.handlers;
    expect(handlers).toBeTruthy();

    handlers?.get("change")?.("/repo/.ade/transcripts/logs/main.jsonl");
    handlers?.get("change")?.("/repo/.ade/cache/tree-index.json");
    handlers?.get("change")?.("/repo/.ade/ade.db-wal");
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
  });

  it("continues filtering .ade events when includeIgnored is not enabled", () => {
    const service = createFileWatcherService();
    const callback = vi.fn();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, callback);
    const handlers = chokidarState.watchers[0]?.handlers;
    expect(handlers).toBeTruthy();

    handlers?.get("add")?.("/repo/.ade/notes/project.md");
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
    expect(chokidarState.watchers[0]?.close).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
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
    expect(chokidarState.watchers[1]?.close).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
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

  it("reuses idle watchers when a view is reopened before the close timer fires", () => {
    const service = createFileWatcherService();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.stop("ws-1", 1, false);

    expect(chokidarState.watchers[0]?.close).not.toHaveBeenCalled();
    expect(chokidarState.watchMock).toHaveBeenCalledTimes(1);

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());

    expect(chokidarState.watchers[0]?.close).not.toHaveBeenCalled();
    expect(chokidarState.watchMock).toHaveBeenCalledTimes(1);

    vi.runOnlyPendingTimers();

    expect(chokidarState.watchers[0]?.close).not.toHaveBeenCalled();
  });

  it("eventually closes an idle watcher after the grace period expires", () => {
    const service = createFileWatcherService();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.stop("ws-1", 1, false);

    expect(chokidarState.watchers[0]?.close).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();

    expect(chokidarState.watchers[0]?.close).toHaveBeenCalledTimes(1);

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());

    expect(chokidarState.watchMock).toHaveBeenCalledTimes(2);
  });

  it("defers closing a watcher until chokidar reports ready", () => {
    chokidarState.setAutoReady(false);
    const service = createFileWatcherService();

    service.watch({ workspaceId: "ws-1", rootPath: "/repo", senderId: 1 }, vi.fn());
    service.stop("ws-1", 1, false);

    vi.runOnlyPendingTimers();
    expect(chokidarState.watchers[0]?.close).not.toHaveBeenCalled();

    chokidarState.watchers[0]?.emitReady();
    vi.runOnlyPendingTimers();

    expect(chokidarState.watchers[0]?.close).toHaveBeenCalledTimes(1);
  });
});
