/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GlossaryPopover } from "./GlossaryPopover";
import type { Term } from "../../onboarding/glossary";

const TERM: Term = {
  id: "lane",
  term: "Lane",
  shortDefinition: "A separate workspace for one task.",
  longDefinition:
    "A Lane is like its own desk — it has its own folder on disk, so changes in one Lane don't mix with another.",
  docUrl: "https://www.ade-app.dev/docs/lanes/overview",
};

(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis.window as any).ade = {
  app: { openExternal: vi.fn(async () => undefined) },
};

afterEach(() => cleanup());

function makeAnchor() {
  const a = document.createElement("button");
  a.textContent = "trigger";
  document.body.appendChild(a);
  return a;
}

describe("GlossaryPopover", () => {
  it("renders term name, short definition, long definition, and doc link", () => {
    const anchor = makeAnchor();
    render(<GlossaryPopover term={TERM} anchor={anchor} onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: TERM.term })).toBeTruthy();
    expect(screen.getByText(TERM.term)).toBeTruthy();
    expect(screen.getByText(TERM.shortDefinition)).toBeTruthy();
    expect(screen.getByText(TERM.longDefinition)).toBeTruthy();

    const link = screen.getByRole("link", { name: /Read more/ }) as HTMLAnchorElement;
    expect(link.href).toContain("/docs/lanes/overview");

    // Electron: clicking should route to openExternal, not the browser's default navigation.
    const ade = (globalThis.window as any).ade as {
      app: { openExternal: ReturnType<typeof vi.fn> };
    };
    ade.app.openExternal.mockClear();
    fireEvent.click(link);
    expect(ade.app.openExternal).toHaveBeenCalledWith(TERM.docUrl);

    anchor.remove();
  });

  it("Escape calls onClose", () => {
    const anchor = makeAnchor();
    const onClose = vi.fn();
    render(<GlossaryPopover term={TERM} anchor={anchor} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    anchor.remove();
  });

  it("click outside the popover and anchor calls onClose", () => {
    const anchor = makeAnchor();
    const stray = document.createElement("div");
    document.body.appendChild(stray);
    const onClose = vi.fn();
    render(<GlossaryPopover term={TERM} anchor={anchor} onClose={onClose} />);

    fireEvent.mouseDown(stray);
    expect(onClose).toHaveBeenCalledTimes(1);

    anchor.remove();
    stray.remove();
  });
});
