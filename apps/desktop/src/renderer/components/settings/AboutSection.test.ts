import { describe, expect, it } from "vitest";
import { resolveAboutVersionState } from "./AboutSection";

describe("resolveAboutVersionState", () => {
  it("keeps a downloaded update distinct from the installed app version", () => {
    expect(resolveAboutVersionState("1.2.34", {
      status: "ready",
      version: "1.2.35",
      parked: null,
    })).toEqual({
      runningVersion: "1.2.34",
      installedVersion: "1.2.34",
      downloadedVersion: "1.2.35",
      restartPending: true,
    });
  });
});
