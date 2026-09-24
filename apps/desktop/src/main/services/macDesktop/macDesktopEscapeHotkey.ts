/**
 * Escape, caught before the app that has the keyboard.
 *
 * The pane's own Escape listener is on `window` in the renderer, so it only
 * ever fires while ADE has focus — and a takeover on the Mac that owns the
 * display is exactly the case where ADE does not. The click that starts the
 * takeover is posted through the HID tap, which macOS cannot tell from a real
 * one, so it activates whatever window sits under it on the lane's display.
 * From that moment the lane's Finder (or Safari, or the agent's editor) owns
 * the keyboard, the renderer sees no `keydown` at all, and the one key a
 * person reaches for when the pointer misbehaves does nothing.
 *
 * A global shortcut is the only mechanism that still works once focus has
 * left. It is armed ONLY while a takeover is live on this Mac:
 *
 * - A remote lane keeps focus in the ADE window, because the clicks land on
 *   another computer. The renderer listener is enough there, and taking the
 *   key system-wide would be an intrusion that buys nothing.
 * - With nothing armed the accelerator is unregistered, so Escape behaves
 *   normally everywhere else on the Mac.
 *
 * Swallowing Escape for the whole machine while a takeover runs is deliberate
 * and not a side effect: Escape is already documented as the way out and is
 * never typed into the lane. A person who wants Escape to reach the lane's Mac
 * sends it with the agent commands, which do not go through the keyboard.
 */

export type MacDesktopEscapeHotkeyDeps = {
  /** `globalShortcut.register`. Returns false when another app owns the key. */
  register: (accelerator: string, handler: () => void) => boolean;
  unregister: (accelerator: string) => void;
  /** Tells one renderer that Escape was pressed. False when it is gone. */
  notify: (webContentsId: number) => boolean;
  log?: (line: string) => void;
};

export const MAC_DESKTOP_ESCAPE_ACCELERATOR = "Escape";

export function createMacDesktopEscapeHotkey(deps: MacDesktopEscapeHotkeyDeps) {
  /** Which renderers hold a local takeover, and on which lane. */
  const armedBy = new Map<number, string>();
  let registered = false;

  const sync = (): void => {
    const wanted = armedBy.size > 0;
    if (wanted === registered) return;
    if (wanted) {
      registered = deps.register(MAC_DESKTOP_ESCAPE_ACCELERATOR, fire);
      // A refusal is reported, never swallowed: a dead panic key that looks
      // armed is worse than one the person knows they do not have.
      if (!registered) {
        deps.log?.("mac_desktop.escape_hotkey_refused");
        armedBy.clear();
      }
      return;
    }
    deps.unregister(MAC_DESKTOP_ESCAPE_ACCELERATOR);
    registered = false;
  };

  /**
   * Every armed renderer hears it, and any that has gone away is dropped.
   *
   * Pruning here is what makes a closed window self-healing: nothing else has
   * to remember to disarm, and the accelerator is given back as soon as the
   * last live holder is gone.
   */
  function fire(): void {
    for (const webContentsId of [...armedBy.keys()]) {
      if (!deps.notify(webContentsId)) armedBy.delete(webContentsId);
    }
    sync();
  }

  return {
    /** Arm for one renderer's takeover of one lane. */
    arm(webContentsId: number, laneId: string): void {
      armedBy.set(webContentsId, laneId);
      sync();
    },
    /** Disarm that renderer. Safe to call when it was never armed. */
    disarm(webContentsId: number): void {
      if (!armedBy.delete(webContentsId)) return;
      sync();
    },
    /** Quit and teardown: never leave the machine's Escape key taken. */
    dispose(): void {
      armedBy.clear();
      sync();
    },
    /** For the contract test and for logs. */
    isArmed(): boolean {
      return registered;
    },
  };
}

export type MacDesktopEscapeHotkey = ReturnType<typeof createMacDesktopEscapeHotkey>;
