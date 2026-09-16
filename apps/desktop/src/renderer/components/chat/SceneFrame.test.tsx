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

  /**
   * The hosted web client exposes a generic fallback proxy for anything under
   * `window.ade`, so `scene.prepare` IS a function, DOES resolve, and resolves
   * `null`. A bare `typeof === "function"` check passed it, `src` became null,
   * and the scene rendered as a blank gap with no error anywhere.
   */
  it("falls back to a blob URL when prepare resolves a non-string", async () => {
    const prepare = vi.fn(async () => null);
    (window as unknown as { ade?: unknown }).ade = { scene: { prepare } };
    try {
      render(<SceneFrame source={'<div id="n">3</div>'} live />);
      const frame = await screen.findByTestId("chat-scene-frame");
      expect(prepare).toHaveBeenCalled();
      expect(frame.getAttribute("src")).toBe("blob:scene-1");
    } finally {
      delete (window as unknown as { ade?: unknown }).ade;
    }
  });

  /**
   * An unterminated fence parses on every streamed tick. Mounting on one
   * prepared a new document and reloaded the iframe several times a second,
   * throwing away whatever the half-written scene had drawn.
   */
  it("holds a placeholder while the scene fence is still streaming", async () => {
    const partial = [
      "```scene",
      '<!-- @scene title="Merged pull requests" -->',
      '<div id="n">3</div>',
    ].join("\n");
    const { rerender } = render(<MarkdownBlock markdown={partial} sceneLive />);
    await waitFor(() => expect(screen.getByTestId("chat-scene")).toBeTruthy());
    expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("drawing");
    expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
    expect(screen.getByTestId("chat-scene").textContent).toContain("Merged pull requests");

    rerender(<MarkdownBlock markdown={SCENE} sceneLive />);
    await screen.findByTestId("chat-scene-frame");
  });

  /** A settled row mounts whatever the fence state says: the turn is over. */
  it("mounts an unterminated fence once the turn is no longer live", async () => {
    render(<MarkdownBlock markdown={"```scene\n<p>truncated"} />);
    await screen.findByTestId("chat-scene-frame");
  });

  it("leaves other fences alone", () => {
    render(<MarkdownBlock markdown={"```ts\nconst a = 1;\n```"} />);
    expect(screen.queryByTestId("chat-scene")).toBeNull();
  });
});
