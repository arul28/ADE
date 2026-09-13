/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownBlock } from "./chatMarkdownBlock";
import { SceneFrame } from "./SceneFrame";

const SCENE = [
  "```scene",
  '<!-- @scene title="Merged pull requests" -->',
  '<div id="n">3</div>',
  "```",
].join("\n");

afterEach(cleanup);

beforeEach(() => {
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => "blob:scene-1");
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});

describe("SceneFrame", () => {
  /**
   * The security property the whole feature rests on. `allow-scripts` WITH
   * `allow-same-origin` would hand the frame back its own origin and let it
   * reach into ADE; this assertion is what stops that pair being introduced by
   * a later edit.
   */
  it("sandboxes scripts without ever granting same-origin", async () => {
    render(<SceneFrame source={'<div id="n">3</div>'} live />);
    const frame = await screen.findByTestId("chat-scene-frame");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerPolicy") ?? frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("shows the title and marks the view as agent-drawn", async () => {
    render(<SceneFrame source={'<!-- @scene title="Merged pull requests" -->\n<p>x</p>'} live />);
    await screen.findByTestId("chat-scene-frame");
    const scene = screen.getByTestId("chat-scene");
    expect(scene.textContent).toContain("Merged pull requests");
    // The caption always states which of the three states the view is in, so a
    // frozen snapshot can never be mistaken for something still updating.
    expect(scene.textContent).toMatch(/drawing|live|frozen/);
  });

  it("falls back to a readable code block when the scene cannot be parsed", () => {
    render(<SceneFrame source={"   "} live />);
    expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
    expect(screen.getByText(/could not be rendered/i)).toBeTruthy();
  });

  /** Any agent can draw, so the fence must not require a render context. */
  it("renders a ```scene fence from an ordinary markdown body", async () => {
    render(<MarkdownBlock markdown={SCENE} sceneLive />);
    await waitFor(() => expect(screen.getByTestId("chat-scene")).toBeTruthy());
    expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).not.toBeNull();
  });

  it("leaves other fences alone", () => {
    render(<MarkdownBlock markdown={"```ts\nconst a = 1;\n```"} />);
    expect(screen.queryByTestId("chat-scene")).toBeNull();
  });
});
