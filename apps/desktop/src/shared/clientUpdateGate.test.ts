import { describe, expect, it } from "vitest";
import { desktopUpdateRequirement } from "./clientUpdateGate";

// The update gate blocks people from working. It must block exactly the
// builds below the owner's minimum, and only when an update that meets the
// minimum exists, so nobody is ever stuck behind a screen they cannot pass.
const minimum = { desktop: { stable: "1.2.131", beta: "1.2.131-beta.2" } };
const latest = { stable: "1.2.131", beta: "1.2.131-beta.3" };

describe("desktopUpdateRequirement", () => {
  it.each([
    ["stable below the minimum", "1.2.130", minimum, latest, true],
    ["stable at the minimum", "1.2.131", minimum, latest, false],
    ["stable above the minimum", "1.2.140", minimum, latest, false],
    ["beta below the beta minimum", "1.2.131-beta.1", minimum, latest, true],
    ["old beta of an older patch", "1.2.130-beta.55", minimum, latest, true],
    ["beta at the beta minimum", "1.2.131-beta.2", minimum, latest, false],
    ["a beta is judged by the beta minimum, not the stable one", "1.2.131-beta.2", { desktop: { stable: "1.2.140", beta: "1.2.131-beta.2" } }, latest, false],
    ["no minimum for the track", "1.2.100", { desktop: { stable: null, beta: "1.2.131-beta.2" } }, latest, false],
    ["no minimum read at all", "1.2.100", null, latest, false],
    ["minimum ahead of every published build", "1.2.130", { desktop: { stable: "1.2.132", beta: null } }, latest, false],
    ["newest build on the track unknown", "1.2.130", minimum, { stable: null, beta: "1.2.131-beta.3" }, false],
    ["alpha build", "1.0.0-beta.1-alpha.202611171957", minimum, latest, false],
    ["dev build", "1.0.0-beta.1", minimum, latest, false],
    ["preview build", "1.2.128-beta.0.preview.7", minimum, latest, false],
    ["no version", null, minimum, latest, false],
  ])("%s", (_name, currentVersion, min, newest, required) => {
    expect(desktopUpdateRequirement({ currentVersion, minimum: min, latest: newest }).required).toBe(required);
  });

  it("names the build that meets the minimum", () => {
    expect(desktopUpdateRequirement({ currentVersion: "1.2.130", minimum, latest })).toEqual({
      required: true,
      track: "stable",
      currentVersion: "1.2.130",
      minimumVersion: "1.2.131",
      targetVersion: "1.2.131",
    });
  });
});
