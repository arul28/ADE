import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAppMenuCommands,
  consumeAppMenuCommand,
  resetAppMenuCommandsForTests,
} from "./appMenuCommands";

afterEach(() => resetAppMenuCommandsForTests());

describe("consumeAppMenuCommand", () => {
  it("is unclaimed by default, so the app-wide default runs", () => {
    expect(consumeAppMenuCommand("find")).toBe(false);
  });

  it("hands the command to the newest claimant that takes it", () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    claimAppMenuCommands(older);
    claimAppMenuCommands(newer);

    expect(consumeAppMenuCommand("close-tab")).toBe(true);
    expect(newer).toHaveBeenCalledWith("close-tab");
    expect(older).not.toHaveBeenCalled();
  });

  it("falls through a claimant that declines this moment", () => {
    const older = vi.fn(() => true);
    claimAppMenuCommands(older);
    claimAppMenuCommands(() => false);

    expect(consumeAppMenuCommand("find")).toBe(true);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it("stops offering the command once the claim is released", () => {
    const handler = vi.fn(() => true);
    const unclaim = claimAppMenuCommands(handler);
    unclaim();
    unclaim();

    expect(consumeAppMenuCommand("find")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
