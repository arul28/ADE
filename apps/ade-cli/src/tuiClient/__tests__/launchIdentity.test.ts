import { describe, expect, it } from "vitest";
import {
  launchIdentityFields,
  resolveLaunchIdentity,
  sameLaunchIdentity,
} from "../launchIdentity";

describe("launch identity", () => {
  it("prefers the inline selectors a session currently reports", () => {
    expect(resolveLaunchIdentity({
      instanceId: "work",
      presetId: "hp_opus",
      credentialId: "openrouter",
      resumeMetadata: {
        instanceId: "stale",
        launch: { instanceId: "staler", presetId: "hp_old", credentialId: "old" },
      },
    })).toEqual({ instanceId: "work", presetId: "hp_opus", credentialId: "openrouter" });
  });

  it("falls back to resume metadata, then to the recorded launch arguments", () => {
    // The bug this guards: a resumed CLI terminal whose inline fields were
    // never populated would launch under the machine default account instead
    // of the one it was started with.
    expect(resolveLaunchIdentity({
      resumeMetadata: {
        presetId: "hp_from_metadata",
        launch: { instanceId: "work", presetId: "hp_from_launch", credentialId: "openrouter" },
      },
    })).toEqual({
      instanceId: "work",
      presetId: "hp_from_metadata",
      credentialId: "openrouter",
    });
  });

  it("resolves an absent selector to null rather than undefined", () => {
    expect(resolveLaunchIdentity(null))
      .toEqual({ instanceId: null, presetId: null, credentialId: null });
    expect(resolveLaunchIdentity({ presetId: undefined, credentialId: null }))
      .toEqual({ instanceId: null, presetId: null, credentialId: null });
  });

  it("omits unset selectors from a launch payload instead of sending null", () => {
    expect(launchIdentityFields({ instanceId: "work", presetId: null, credentialId: null }))
      .toEqual({ instanceId: "work" });
    expect(launchIdentityFields({ instanceId: null, presetId: null, credentialId: null }))
      .toEqual({});
    // An empty selector survives the `??` chain but is still not a selection.
    expect(launchIdentityFields({ instanceId: "", presetId: null, credentialId: null }))
      .toEqual({});
  });

  it("compares two identities by every selector", () => {
    const base = { instanceId: "work", presetId: null, credentialId: null };
    expect(sameLaunchIdentity(base, { ...base })).toBe(true);
    expect(sameLaunchIdentity(base, { ...base, credentialId: "openrouter" })).toBe(false);
  });
});
