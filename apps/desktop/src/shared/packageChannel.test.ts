import { describe, expect, it } from "vitest";

import {
  PACKAGE_CHANNEL_ARGV_PREFIX,
  normalizeAppPackageChannel,
  resolvePackageChannelFromProcess,
} from "./packageChannel";

// argv/env are injected rather than mutated, so these run identically on every
// host (same pattern as main/services/shared/pathCompare.test.ts).
describe("normalizeAppPackageChannel", () => {
  it("accepts alpha and beta in any casing", () => {
    expect(normalizeAppPackageChannel("beta")).toBe("beta");
    expect(normalizeAppPackageChannel(" BETA ")).toBe("beta");
    expect(normalizeAppPackageChannel("Alpha")).toBe("alpha");
  });

  it("treats every other value as stable", () => {
    for (const value of [undefined, null, "", "stable", "nightly", 7, {}]) {
      expect(normalizeAppPackageChannel(value)).toBe("stable");
    }
  });
});

describe("resolvePackageChannelFromProcess", () => {
  it("reads the channel main.ts injects through additionalArguments", () => {
    expect(
      resolvePackageChannelFromProcess({
        argv: ["electron.exe", `${PACKAGE_CHANNEL_ARGV_PREFIX}beta`],
        env: {},
      }),
    ).toBe("beta");
  });

  it("prefers argv over the inherited environment", () => {
    expect(
      resolvePackageChannelFromProcess({
        argv: [`${PACKAGE_CHANNEL_ARGV_PREFIX}stable`],
        env: { ADE_PACKAGE_CHANNEL: "alpha" },
      }),
    ).toBe("stable");
  });

  it("falls back to ADE_PACKAGE_CHANNEL when argv carries nothing", () => {
    expect(
      resolvePackageChannelFromProcess({
        argv: ["electron.exe", "--some-other-flag"],
        env: { ADE_PACKAGE_CHANNEL: "alpha" },
      }),
    ).toBe("alpha");
  });

  it("is stable when neither source says otherwise", () => {
    expect(resolvePackageChannelFromProcess({})).toBe("stable");
  });
});
