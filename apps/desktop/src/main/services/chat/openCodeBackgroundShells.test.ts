import type { OpenCodeClient } from "@opencode/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEvent } from "../../../shared/types/chat";
import {
  createOpenCodeBackgroundShells,
  openCodeBackgroundShellStarted,
  type OpenCodeBackgroundShellEnd,
  type OpenCodeBackgroundShells,
} from "./openCodeBackgroundShells";

type ScheduledWorkEvent = Extract<AgentChatEvent, { type: "scheduled_work_update" }>;

type ShellFixture = {
  id: string;
  status: "running" | "exited" | "timeout" | "killed";
  pid?: number;
  exit?: number;
};

/** The subset of a real `ShellInfo` the tracker reads. */
function shellInfo(shell: ShellFixture): Record<string, unknown> & ShellFixture {
  return {
    id: shell.id,
    status: shell.status,
    command: "npm run dev",
    cwd: "/tmp",
    shell: "/bin/zsh",
    file: "/tmp/ade-shell",
    ...(shell.pid !== undefined ? { pid: shell.pid } : {}),
    ...(shell.exit !== undefined ? { exit: shell.exit } : {}),
    metadata: {},
    time: { started: 1 },
  };
}

function shellMap(...shells: ShellFixture[]) {
  return new Map(shells.map((shell) => [shell.id, shellInfo(shell)] as const));
}

/**
 * A fake OpenCode client plus the two process-boundary seams (kill tree, alive
 * probe). Only the client and the OS process calls are faked; the tracker is
 * the real module.
 */
function makeTracker(args: {
  shellsById: Map<string, ReturnType<typeof shellInfo>>;
  alive?: Set<number>;
  isLive?: () => boolean;
}) {
  const events: ScheduledWorkEvent[] = [];
  const alive = args.alive ?? new Set<number>();
  const killProcessTree = vi.fn((pid: number) => {
    alive.delete(pid);
  });
  const client = {
    shell: {
      get: vi.fn(async ({ id }: { id: string }) => {
        const info = args.shellsById.get(id);
        if (!info) throw new Error(`no shell ${id}`);
        return { data: info };
      }),
      list: vi.fn(async () => ({ data: [...args.shellsById.values()] })),
    },
  } as unknown as Pick<OpenCodeClient, "shell">;
  const backgrounds: OpenCodeBackgroundShells = createOpenCodeBackgroundShells({
    client,
    directory: "/tmp",
    emit: (event) => events.push(event),
    currentTurnId: () => "turn-1",
    killProcessTree,
    isProcessAlive: (pid) => alive.has(pid),
    isLive: args.isLive ?? (() => true),
  });
  return { backgrounds, events, alive, killProcessTree };
}

const START = { shellId: "sh-1", command: "npm run dev" };

afterEach(() => {
  vi.useRealTimers();
});

describe("openCodeBackgroundShellStarted", () => {
  it.each([
    [
      "a background tool success",
      { type: "session.tool.success", data: { id: "call-1", metadata: { status: "running", shellID: "sh-1" } } },
      { command: "  npm run dev  " },
      { shellId: "sh-1", command: "npm run dev" },
    ],
    // A foreground tool has no shellID; tracking it would pin the chat forever.
    ["a finished foreground tool", { type: "session.tool.success", data: { id: "call-1", metadata: { status: "completed" } } }, {}, null],
    ["a background report with no shell id", { type: "session.tool.success", data: { id: "call-1", metadata: { status: "running" } } }, {}, null],
    ["a non-success event", { type: "session.tool.failed", data: { id: "call-1", metadata: { status: "running", shellID: "sh-1" } } }, {}, null],
  ])("reports %s as a started background shell or not", (_label, event, input, expected) => {
    expect(openCodeBackgroundShellStarted(event as never, input)).toEqual(expected);
  });
});

describe("OpenCode background shells tracker", () => {
  it("tracks a running shell and settles its row once, on the reported exit", () => {
    const { backgrounds, events } = makeTracker({ shellsById: shellMap({ id: "sh-1", status: "running", pid: 1 }) });
    backgrounds.track(START, "call-1");

    expect(backgrounds.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "background_task", status: "running", sourceTaskId: "sh-1" });

    backgrounds.settle({ shellId: "sh-1", status: "completed", exitCode: 0 });
    expect(backgrounds.size).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "background_task", status: "completed", sourceTaskId: "sh-1" });

    // A duplicate end (shell.exited then shell.deleted) must not emit twice.
    backgrounds.settle({ shellId: "sh-1", status: "stopped", exitCode: null });
    expect(events).toHaveLength(2);
  });

  it("settles a shell whose end arrived before its start was tracked", () => {
    const { backgrounds, events } = makeTracker({ shellsById: shellMap() });
    const earlyEnd: OpenCodeBackgroundShellEnd = { shellId: "sh-1", status: "completed", exitCode: 0 };

    backgrounds.settle(earlyEnd);
    expect(backgrounds.size).toBe(0);
    expect(events).toHaveLength(0);

    backgrounds.track(START, "call-1");
    expect(backgrounds.size).toBe(0);
    // The running row then the completed row: the late start never leaves a
    // shell spinning forever.
    expect(events.map((event) => event.status)).toEqual(["running", "completed"]);
  });

  it("exposes the idle-sweep signal while a shell runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { backgrounds } = makeTracker({ shellsById: shellMap() });

    backgrounds.track(START, "call-1");
    vi.setSystemTime(5_000);
    backgrounds.track({ shellId: "sh-2", command: "npm test" }, "call-2");

    expect(backgrounds.size).toBe(2);
    expect(backgrounds.earliestStartedAt()).toBe(1_000);
    expect(backgrounds.has("sh-2")).toBe(true);

    backgrounds.settle({ shellId: "sh-1", status: "completed", exitCode: 0 });
    expect(backgrounds.size).toBe(1);
    expect(backgrounds.earliestStartedAt()).toBe(5_000);
  });

  it("settles stopOne only after the process is gone", async () => {
    const { backgrounds, events, killProcessTree } = makeTracker({
      shellsById: shellMap({ id: "sh-1", status: "running", pid: 4242 }),
      alive: new Set([4242]),
    });

    backgrounds.track(START, "call-1");
    const result = await backgrounds.stopOne("sh-1");

    expect(result).toEqual({ stopped: true });
    expect(killProcessTree).toHaveBeenCalledWith(4242);
    expect(backgrounds.size).toBe(0);
    expect(events.at(-1)).toMatchObject({ status: "stopped", stopSource: "user", sourceTaskId: "sh-1" });
  });

  it("reports a surviving process and leaves the shell tracked", async () => {
    vi.useFakeTimers();
    const { backgrounds, events, killProcessTree } = makeTracker({
      shellsById: shellMap({ id: "sh-1", status: "running", pid: 4242 }),
      alive: new Set([4242]),
    });
    // The kill is signalled but the pid never goes away: a wedged shell.
    killProcessTree.mockImplementation(() => {});
    backgrounds.track(START, "call-1");

    const pending = backgrounds.stopOne("sh-1");
    await vi.advanceTimersByTimeAsync(3_500);

    await expect(pending).resolves.toMatchObject({ stopped: false });
    expect(backgrounds.size).toBe(1);
    // Only the initial running row; a survivor is never settled as stopped.
    expect(events).toHaveLength(1);
  });

  it("reconciles a tracked shell OpenCode no longer lists, and its reported end", async () => {
    const { backgrounds, events } = makeTracker({
      shellsById: shellMap({ id: "sh-2", status: "exited", exit: 3 }),
    });

    backgrounds.track({ shellId: "sh-1", command: "gone" }, "call-1");
    backgrounds.track({ shellId: "sh-2", command: "exited" }, "call-2");
    await backgrounds.reconcile();

    expect(backgrounds.size).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ sourceTaskId: "sh-1", status: "completed" }));
    expect(events).toContainEqual(expect.objectContaining({ sourceTaskId: "sh-2", status: "failed" }));
  });

  it("stopAll settles the killed shells and keeps a survivor tracked", async () => {
    vi.useFakeTimers();
    const { backgrounds, killProcessTree } = makeTracker({
      shellsById: shellMap(
        { id: "sh-1", status: "running", pid: 11 },
        { id: "sh-2", status: "running", pid: 22 },
      ),
      alive: new Set([11, 22]),
    });
    // Only sh-1 actually dies; sh-2 survives its kill.
    const realKill = killProcessTree.getMockImplementation()!;
    killProcessTree.mockImplementation((pid: number) => {
      if (pid === 11) realKill(pid);
    });
    backgrounds.track({ shellId: "sh-1", command: "a" }, "call-1");
    backgrounds.track({ shellId: "sh-2", command: "b" }, "call-2");

    const pending = backgrounds.stopAll({ stopSource: "user" });
    await vi.advanceTimersByTimeAsync(3_500);

    await expect(pending).resolves.toBe(1);
    expect(backgrounds.size).toBe(1);
    expect(backgrounds.has("sh-2")).toBe(true);
  });
});
