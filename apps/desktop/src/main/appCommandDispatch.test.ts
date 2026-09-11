import { describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc";
import {
  createAppCommandSender,
  type AppCommandWindow,
} from "./appCommandDispatch";

type FakeWindow = AppCommandWindow & {
  sent: { channel: string; payload: unknown }[];
};

function createWindow(options: {
  id?: number;
  crashed?: boolean;
  /** null = the renderer never answers (wedged); otherwise it answers immediately. */
  answers?: boolean;
} = {}): FakeWindow {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    id: options.id ?? 1,
    isDestroyed: () => false,
    sent,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => options.crashed === true,
      send: (channel, payload) => {
        sent.push({ channel, payload });
      },
      executeJavaScript: () => (
        options.answers === false
          ? new Promise<unknown>(() => {})
          : Promise.resolve(0)
      ),
    },
  };
}

describe("createAppCommandSender", () => {
  it("sends zoom and menu commands on the one unified channel", async () => {
    const send = createAppCommandSender<FakeWindow>({ hasRenderer: () => true });
    const win = createWindow();

    send({ kind: "zoom", command: "in" }, win);
    send({ kind: "menu", command: "find" }, win);

    expect(win.sent).toEqual([
      { channel: IPC.appCommand, payload: { kind: "zoom", command: "in" } },
      { channel: IPC.appCommand, payload: { kind: "menu", command: "find" } },
    ]);
  });

  it("runs the fallback for a window that has no ADE renderer in it", () => {
    const send = createAppCommandSender<FakeWindow>({ hasRenderer: () => false });
    const win = createWindow();
    const fallback = vi.fn();

    send({ kind: "menu", command: "close-tab" }, win, fallback);

    expect(win.sent).toEqual([]);
    expect(fallback).toHaveBeenCalledWith(win);
  });

  /*
    The gap `executeJavaScript` cannot see.

    The probe answers "alive" as soon as the renderer has a JS context, which is
    a second or more before React mounts `TopBar` and subscribes. ⌘W landed on a
    window with no listener for that whole stretch and did nothing at all — the
    one command that must never be a no-op, because it is the escape hatch for a
    window that is not answering.
  */
  it("closes the window itself until its renderer says the subscriber is live", () => {
    const subscribers = new Set<number>();
    const send = createAppCommandSender<FakeWindow>({
      hasRenderer: () => true,
      hasCommandSubscriber: (windowId) => subscribers.has(windowId),
    });
    const win = createWindow({ id: 7 });
    const fallback = vi.fn();

    send({ kind: "menu", command: "close-tab" }, win, fallback);
    expect(win.sent).toEqual([]);
    expect(fallback).toHaveBeenCalledWith(win);

    subscribers.add(7);
    fallback.mockClear();
    send({ kind: "menu", command: "close-tab" }, win, fallback);
    expect(win.sent).toEqual([
      { channel: IPC.appCommand, payload: { kind: "menu", command: "close-tab" } },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("still sends a command with no fallback before the subscriber acks", () => {
    // Zoom and find have no app-wide fallback to run instead, and losing one is
    // a no-op rather than a dead window — so they are not held back.
    const send = createAppCommandSender<FakeWindow>({
      hasRenderer: () => true,
      hasCommandSubscriber: () => false,
    });
    const win = createWindow();

    send({ kind: "zoom", command: "in" }, win);

    expect(win.sent).toEqual([
      { channel: IPC.appCommand, payload: { kind: "zoom", command: "in" } },
    ]);
  });

  it("closes a crashed window itself instead of sending into the void", () => {
    // ⌘W is the escape hatch for a window that has stopped answering, so it
    // must not depend on that window answering. `role: "close"` closed
    // unconditionally from the browser process; this is what replaces it.
    const send = createAppCommandSender<FakeWindow>({ hasRenderer: () => true });
    const win = createWindow({ crashed: true });
    const fallback = vi.fn();

    send({ kind: "menu", command: "close-tab" }, win, fallback);

    expect(win.sent).toEqual([]);
    expect(fallback).toHaveBeenCalledWith(win);
  });

  it("falls back when a live renderer does not answer inside the bound", async () => {
    const send = createAppCommandSender<FakeWindow>({
      hasRenderer: () => true,
      livenessTimeoutMs: 5,
    });
    // Not crashed, just wedged in a long task: `isCrashed()` says nothing about
    // it, and the command it was just sent will never be handled.
    const win = createWindow({ answers: false });
    const fallback = vi.fn();

    send({ kind: "menu", command: "close-tab" }, win, fallback);
    expect(win.sent).toHaveLength(1);

    await vi.waitFor(() => expect(fallback).toHaveBeenCalledWith(win));
  });

  it("leaves a healthy renderer to answer its own command", async () => {
    const send = createAppCommandSender<FakeWindow>({
      hasRenderer: () => true,
      livenessTimeoutMs: 50,
    });
    const win = createWindow();
    const fallback = vi.fn();

    send({ kind: "menu", command: "close-tab" }, win, fallback);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(win.sent).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not probe a command that has no app-wide fallback", async () => {
    const executeJavaScript = vi.fn(async () => 0);
    const send = createAppCommandSender<FakeWindow>({ hasRenderer: () => true });
    const win = createWindow();
    win.webContents.executeJavaScript = executeJavaScript;

    send({ kind: "menu", command: "find" }, win);
    await Promise.resolve();

    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("ignores a destroyed or missing window", () => {
    const send = createAppCommandSender<FakeWindow>({ hasRenderer: () => true });
    const fallback = vi.fn();
    const destroyed = createWindow();
    destroyed.isDestroyed = () => true;

    send({ kind: "zoom", command: "reset" }, null, fallback);
    send({ kind: "zoom", command: "reset" }, destroyed, fallback);

    expect(destroyed.sent).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });
});
