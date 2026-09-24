import { describe, expect, it, vi } from "vitest";
import { createMacDesktopEscapeHotkey } from "./macDesktopEscapeHotkey";

function harness(options: { register?: () => boolean } = {}) {
  const registered: Array<() => void> = [];
  const unregistered: string[] = [];
  const notified: number[] = [];
  const dead = new Set<number>();
  const hotkey = createMacDesktopEscapeHotkey({
    register: (_accelerator, handler) => {
      const ok = options.register ? options.register() : true;
      if (ok) registered.push(handler);
      return ok;
    },
    unregister: (accelerator) => { unregistered.push(accelerator); },
    notify: (id) => {
      if (dead.has(id)) return false;
      notified.push(id);
      return true;
    },
    log: vi.fn(),
  });
  return { hotkey, registered, unregistered, notified, dead };
}

describe("createMacDesktopEscapeHotkey", () => {
  it("takes the key only while a takeover is live, and gives it straight back", () => {
    const { hotkey, registered, unregistered } = harness();
    expect(hotkey.isArmed()).toBe(false);

    hotkey.arm(1, "lane-a");
    expect(hotkey.isArmed()).toBe(true);
    expect(registered).toHaveLength(1);

    // A second pane does not register the accelerator twice.
    hotkey.arm(2, "lane-b");
    expect(registered).toHaveLength(1);

    // Nor does the first one leaving give it up while the second still holds.
    hotkey.disarm(1);
    expect(hotkey.isArmed()).toBe(true);
    expect(unregistered).toHaveLength(0);

    hotkey.disarm(2);
    expect(hotkey.isArmed()).toBe(false);
    expect(unregistered).toEqual(["Escape"]);
  });

  it("tells every armed pane, and forgets one whose window has gone", () => {
    const { hotkey, registered, notified, dead, unregistered } = harness();
    hotkey.arm(1, "lane-a");
    hotkey.arm(2, "lane-b");

    registered[0]!();
    expect(notified).toEqual([1, 2]);

    // The window closed without disarming. The next press prunes it, and the
    // machine gets its Escape key back with nothing else having to remember.
    dead.add(1);
    dead.add(2);
    registered[0]!();
    expect(hotkey.isArmed()).toBe(false);
    expect(unregistered).toEqual(["Escape"]);
  });

  it("does not pretend to be armed when another app owns the key", () => {
    const { hotkey } = harness({ register: () => false });
    hotkey.arm(1, "lane-a");
    // A dead panic key that looks armed is worse than one the person knows
    // they do not have.
    expect(hotkey.isArmed()).toBe(false);
  });

  it("never leaves the machine's Escape taken after a dispose", () => {
    const { hotkey, unregistered } = harness();
    hotkey.arm(1, "lane-a");
    hotkey.dispose();
    expect(hotkey.isArmed()).toBe(false);
    expect(unregistered).toEqual(["Escape"]);
  });

  it("ignores a disarm for a pane that never armed", () => {
    const { hotkey, unregistered } = harness();
    hotkey.arm(1, "lane-a");
    hotkey.disarm(99);
    expect(hotkey.isArmed()).toBe(true);
    expect(unregistered).toHaveLength(0);
  });
});
