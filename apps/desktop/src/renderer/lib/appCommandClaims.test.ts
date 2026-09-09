import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandClaims } from "./appCommandClaims";
import {
  claimAppMenuCommands,
  consumeAppMenuCommand,
  resetAppMenuCommandsForTests,
} from "./appMenuCommands";
import {
  claimAppZoomCommands,
  consumeAppZoomCommand,
  resetAppZoomCommandsForTests,
} from "./appZoomCommands";

describe("createCommandClaims", () => {
  it("falls through to the app-wide default when nothing has claimed the chord", () => {
    const claims = createCommandClaims<string>();
    expect(claims.consume("in")).toBe(false);
  });

  it("hands the command to a claimant that says it wants it", () => {
    const claims = createCommandClaims<string>();
    const handler = vi.fn(() => true);
    claims.claim(handler);
    expect(claims.consume("out")).toBe(true);
    expect(handler).toHaveBeenCalledWith("out");
  });

  it("still runs the app-wide default when the claimant declines", () => {
    // The browser pane is mounted but the composer has focus: the pane declines
    // and ⌘− must go on meaning "make ADE smaller".
    const claims = createCommandClaims<string>();
    claims.claim(() => false);
    expect(claims.consume("reset")).toBe(false);
  });

  it("offers the newest claimant first and stops at the one that handles it", () => {
    const claims = createCommandClaims<string>();
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    claims.claim(older);
    claims.claim(newer);
    expect(claims.consume("in")).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it("falls back to an older claimant when the newest declines", () => {
    const claims = createCommandClaims<string>();
    const older = vi.fn(() => true);
    claims.claim(older);
    claims.claim(() => false);
    expect(claims.consume("in")).toBe(true);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it("stops offering once a pane unmounts, and the unclaim is safe twice", () => {
    const claims = createCommandClaims<string>();
    const handler = vi.fn(() => true);
    const unclaim = claims.claim(handler);
    unclaim();
    unclaim();
    expect(claims.consume("in")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps each registry's claims to itself", () => {
    const a = createCommandClaims<string>();
    const b = createCommandClaims<string>();
    a.claim(() => true);
    expect(b.consume("in")).toBe(false);
  });

  it("drops every claim on reset", () => {
    const claims = createCommandClaims<string>();
    claims.claim(() => true);
    claims.resetForTests();
    expect(claims.consume("in")).toBe(false);
  });
});

// The two app registries are thin instances of the factory; each keeps one
// assertion proving it is wired to its own registry rather than a shared one.
describe("app command registries", () => {
  afterEach(() => {
    resetAppZoomCommandsForTests();
    resetAppMenuCommandsForTests();
  });

  it.each([
    {
      name: "zoom",
      claim: claimAppZoomCommands,
      consume: consumeAppZoomCommand,
      command: "in",
      other: consumeAppMenuCommand,
      otherCommand: "find",
    },
    {
      name: "menu",
      claim: claimAppMenuCommands,
      consume: consumeAppMenuCommand,
      command: "find",
      other: consumeAppZoomCommand,
      otherCommand: "in",
    },
  ] as const)("routes $name commands to $name claimants only", (registry) => {
    const handler = vi.fn(() => true);
    registry.claim(handler as never);
    expect(registry.consume(registry.command as never)).toBe(true);
    expect(handler).toHaveBeenCalledWith(registry.command);
    expect(registry.other(registry.otherCommand as never)).toBe(false);
  });
});
