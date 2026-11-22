/* @vitest-environment jsdom */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createTerminalTypeAhead } from "./terminalTypeAhead";

beforeAll(() => {
  // jsdom has no canvas backend; the layer only asks it for a text width.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null as never);
});

afterAll(() => {
  vi.restoreAllMocks();
});

/**
 * A terminal stand-in with a real DOM host: the guess layer is drawn over
 * `.xterm-screen`, so the test reads the layer's text and display from the DOM
 * the same way a person sees it. Nothing here is a real xterm instance — the
 * module only reads modes, the active buffer, the cursor and the size.
 */
function fakeTerminal() {
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  Object.defineProperty(screen, "clientWidth", { value: 800 });
  Object.defineProperty(screen, "clientHeight", { value: 400 });
  Object.defineProperty(screen, "offsetLeft", { value: 0 });
  Object.defineProperty(screen, "offsetTop", { value: 0 });
  host.appendChild(screen);
  document.body.appendChild(host);
  const subscribing = { dispose: () => {} };
  const term = {
    cols: 80,
    rows: 24,
    element: host,
    modes: { mouseTrackingMode: "none" },
    buffer: { active: { type: "normal", viewportY: 0, baseY: 0, cursorX: 0, cursorY: 2 } },
    options: { theme: {}, fontFamily: "monospace", fontSize: 13 },
    onWriteParsed: () => subscribing,
    onResize: () => subscribing,
    onScroll: () => subscribing,
  } as unknown as Terminal;
  return { term, host };
}

/** What the guess layer shows now, or null when it is not drawn. */
function guessShown(host: HTMLElement): string | null {
  const layer = host.querySelector<HTMLElement>("[data-terminal-type-ahead]");
  return layer && layer.style.display !== "none" ? layer.textContent : null;
}

describe("type-ahead on a slow link", () => {
  it.each([
    {
      name: "a password prompt that arrives after the first character is not an echo",
      play(typeAhead: ReturnType<typeof createTerminalTypeAhead>) {
        // Type "P" before the prompt arrives, then the prompt, then "a".
        typeAhead.noteInput("P");
        typeAhead.noteOutput("Password: ");
        typeAhead.noteInput("a");
      },
    },
    {
      name: "a confirmed line ends at the next output line",
      play(typeAhead: ReturnType<typeof createTerminalTypeAhead>) {
        // A real echo confirms this line...
        typeAhead.noteInput("l");
        typeAhead.noteOutput("l");
        typeAhead.noteInput("s");
        // ...and the password prompt on the next line must not inherit it.
        typeAhead.noteOutput("\r\nPassword: ");
        typeAhead.noteInput("a");
      },
    },
  ])("draws nothing: $name", ({ play }) => {
    const { term, host } = fakeTerminal();
    const typeAhead = createTerminalTypeAhead({ term, now: () => 0 });
    typeAhead.setWanted(true, 700);
    try {
      play(typeAhead);
      expect(guessShown(host)).toBeNull();
    } finally {
      typeAhead.dispose();
      host.remove();
    }
  });

  it("draws the typed characters once the program has echoed the line, and nothing on a good link", () => {
    const { term, host } = fakeTerminal();
    const typeAhead = createTerminalTypeAhead({ term, now: () => 0 });
    try {
      // A good link asks for no guesses at all.
      typeAhead.noteInput("l");
      typeAhead.noteOutput("l");
      typeAhead.noteInput("s");
      expect(guessShown(host)).toBeNull();

      // Nothing before an echo: a guess the program may not share is not drawn.
      typeAhead.setWanted(true, 700);
      typeAhead.noteInput("\r");
      typeAhead.noteInput("l");
      expect(guessShown(host)).toBeNull();
      // The echo confirms the line; the rest of what is typed is drawn.
      typeAhead.noteOutput("l");
      typeAhead.noteInput("s");
      expect(guessShown(host)).toBe("s");
      // The echo takes the guess's place.
      typeAhead.noteOutput("s");
      expect(guessShown(host)).toBeNull();
    } finally {
      typeAhead.dispose();
      host.remove();
    }
  });
});
