import { describe, expect, it } from "vitest";
import { readBrainStartupState } from "./brainStartupState";

function deps(overrides: {
  installed?: boolean | null;
  running?: boolean | null;
  pid?: number | null;
  ageMs?: number | null;
} = {}) {
  return {
    getServiceStatus: async () => ({
      installed: overrides.installed === undefined ? true : overrides.installed,
      running: overrides.running === undefined ? true : overrides.running,
    }),
    getServiceMainPid: async () => (overrides.pid === undefined ? 4242 : overrides.pid),
    readBrainAgeMs: async () => (overrides.ageMs === undefined ? 5_000 : overrides.ageMs),
    youngBrainMs: 120_000,
  };
}

describe("readBrainStartupState", () => {
  it("calls a registered service whose brain is young 'starting'", async () => {
    await expect(readBrainStartupState(deps())).resolves.toMatchObject({
      starting: true,
      ageMs: 5_000,
    });
  });

  it("stops calling it starting once the brain outlives the young window", async () => {
    await expect(readBrainStartupState(deps({ ageMs: 130_000 }))).resolves.toMatchObject({
      starting: false,
    });
  });

  it("is not starting when the service is absent or stopped", async () => {
    await expect(readBrainStartupState(deps({ installed: false }))).resolves.toMatchObject({
      starting: false,
    });
    await expect(readBrainStartupState(deps({ running: false }))).resolves.toMatchObject({
      starting: false,
    });
  });

  it("fails closed when the age cannot be read or a probe throws", async () => {
    await expect(readBrainStartupState(deps({ ageMs: null }))).resolves.toMatchObject({
      starting: false,
    });
    await expect(readBrainStartupState({
      getServiceStatus: async () => {
        throw new Error("systemctl missing");
      },
    })).resolves.toMatchObject({ starting: false });
  });
});
