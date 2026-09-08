import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAppZoomCommands,
  consumeAppZoomCommand,
  resetAppZoomCommandsForTests,
} from "./appZoomCommands";

afterEach(() => resetAppZoomCommandsForTests());

describe("consumeAppZoomCommand", () => {
  it("falls through to the app zoom when nothing has claimed the chord", () => {
    expect(consumeAppZoomCommand("in")).toBe(false);
  });

  it("hands the command to a claimant that says it wants it", () => {
    const handler = vi.fn(() => true);
    claimAppZoomCommands(handler);
    expect(consumeAppZoomCommand("out")).toBe(true);
    expect(handler).toHaveBeenCalledWith("out");
  });

  it("still zooms the app when the claimant declines", () => {
    // The browser pane is mounted but the composer has focus: the pane declines
    // and ⌘− must go on meaning "make ADE smaller".
    claimAppZoomCommands(() => false);
    expect(consumeAppZoomCommand("reset")).toBe(false);
  });

  it("offers the newest claimant first and stops at the one that handles it", () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    claimAppZoomCommands(older);
    claimAppZoomCommands(newer);
    expect(consumeAppZoomCommand("in")).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it("falls back to an older claimant when the newest declines", () => {
    const older = vi.fn(() => true);
    claimAppZoomCommands(older);
    claimAppZoomCommands(() => false);
    expect(consumeAppZoomCommand("in")).toBe(true);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it("stops offering once a pane unmounts", () => {
    const handler = vi.fn(() => true);
    const unclaim = claimAppZoomCommands(handler);
    unclaim();
    unclaim();
    expect(consumeAppZoomCommand("in")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
