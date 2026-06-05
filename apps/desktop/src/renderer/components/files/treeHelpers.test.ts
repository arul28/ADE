import { describe, expect, it } from "vitest";
import { isUnavailableGitDecorationsError } from "./treeHelpers";

describe("isUnavailableGitDecorationsError", () => {
  it("matches optional remote git decoration action availability failures", () => {
    expect(
      isUnavailableGitDecorationsError(
        new Error(
          "Error invoking remote method 'ade.remoteRuntime.callAction': Error: Action 'file.refreshGitDecorations' is not callable.",
        ),
      ),
    ).toBe(true);
    expect(
      isUnavailableGitDecorationsError(
        new Error("Action 'file.refreshGitDecorations' is not exposed through ADE actions."),
      ),
    ).toBe(true);
  });

  it("does not hide unrelated Files errors", () => {
    expect(isUnavailableGitDecorationsError(new Error("ENOENT: no such file or directory"))).toBe(false);
    expect(isUnavailableGitDecorationsError(new Error("Action 'file.readFile' is not callable."))).toBe(false);
  });
});
