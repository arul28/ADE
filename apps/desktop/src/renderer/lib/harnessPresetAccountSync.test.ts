/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HARNESS_PRESETS_SETTING_KEY, type HarnessPreset } from "../../shared/harnessPresets";
import type { AccountSettingsResult } from "../../shared/types/accountSettings";
import { encodeRoutePresetId } from "../../shared/harnessRoutes";
import { rootAppStoreApi } from "../state/appStore";
import { registerAccountSettingsSync } from "./accountSettingsFlush";
import type { AccountSettingsSyncHandle } from "./accountSettingsSync";
import {
  ensureHarnessPresetOnBrain,
  saveHarnessPresetsToAccount,
} from "./harnessPresetAccountSync";

/**
 * The save-then-launch path, which is the one that broke.
 *
 * A preset is written to the renderer store and reaches the brain on a sync
 * tick; the brain is also what RESOLVES a launch, out of the same copy. Saving
 * and immediately launching therefore used to miss by seconds and report the
 * preset as gone, falling the chat back to the harness's own sign-in. These
 * cases pin the two guarantees the fix added: a save answers what the brain
 * said, and a launch checks the machine's copy and pushes this machine's list
 * when the preset is not there yet.
 *
 * Only the process boundary is faked — `window.ade.accountSettings`, and the
 * sync handle `useAccountSettingsSync` registers in production.
 */

function preset(id: string, name = `Preset ${id}`): HarnessPreset {
  return {
    id,
    name,
    harness: "claude",
    source: { kind: "key", provider: "anthropic", credentialId: "work", label: "Work key" },
    model: "claude-opus-4-5",
    subagentModel: "inherit",
    agentOverrides: {},
    agentEfforts: {},
    accentColor: "#7c5ce0",
    logo: { kind: "ade" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

type FakeApi = {
  list: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

function installApi(options: {
  /** Preset ids the machine's settings cache already holds. */
  machineIds: string[] | null;
  setResult?: AccountSettingsResult<null>;
}): FakeApi {
  const list = vi.fn(async () => (
    options.machineIds === null
      ? { ok: false as const, unavailable: true as const, message: "no brain" }
      : {
        ok: true as const,
        value: [{
          scope: "all",
          key: HARNESS_PRESETS_SETTING_KEY,
          value: options.machineIds.map((id) => preset(id)),
          updatedAt: "2026-01-01T00:00:00.000Z",
          changedAt: null,
          writerDeviceId: null,
        }],
      }
  ));
  const set = vi.fn(async () => options.setResult ?? { ok: true as const, value: null });
  (window as unknown as { ade?: unknown }).ade = { accountSettings: { list, set } };
  return { list, set };
}

let flush: ReturnType<typeof vi.fn>;

beforeEach(() => {
  flush = vi.fn(async () => ({ ok: true as const, value: null }));
  // The same handle shape `useAccountSettingsSync` registers on mount.
  registerAccountSettingsSync(
    Object.assign(() => {}, { flushKey: flush }) as unknown as AccountSettingsSyncHandle,
  );
});

afterEach(() => {
  registerAccountSettingsSync(null);
  rootAppStoreApi.setState({ harnessPresets: [] });
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("harnessPresetAccountSync", () => {
  it("reports the brain's own reason when a save is not confirmed", async () => {
    installApi({ machineIds: [] });
    flush.mockResolvedValueOnce({
      ok: false,
      unavailable: true,
      message: "ADE's background service isn't running on this computer.",
    });
    await expect(saveHarnessPresetsToAccount()).resolves.toEqual({
      ok: false,
      message: "ADE's background service isn't running on this computer.",
    });

    flush.mockResolvedValueOnce({ ok: true, value: null });
    await expect(saveHarnessPresetsToAccount()).resolves.toEqual({ ok: true, message: null });
  });

  it("pushes this machine's list when the brain does not hold the preset yet", async () => {
    rootAppStoreApi.setState({ harnessPresets: [preset("hp_new")] });
    const api = installApi({ machineIds: ["hp_old"] });

    await expect(ensureHarnessPresetOnBrain("hp_new")).resolves.toEqual({ ok: true, message: null });
    expect(api.list).toHaveBeenCalledWith({ scope: "all" });
    expect(flush).toHaveBeenCalledWith(HARNESS_PRESETS_SETTING_KEY);
  });

  it("does not write when the brain already holds it", async () => {
    rootAppStoreApi.setState({ harnessPresets: [preset("hp_new")] });
    installApi({ machineIds: ["hp_new"] });

    await expect(ensureHarnessPresetOnBrain("hp_new")).resolves.toEqual({ ok: true, message: null });
    expect(flush).not.toHaveBeenCalled();
  });

  it("pushes when the brain's copy is an older EDIT of the same preset", async () => {
    // An edit whose upload failed leaves the id present with the previous
    // content, so the brain would launch the model the user just replaced.
    rootAppStoreApi.setState({ harnessPresets: [{ ...preset("hp_new"), model: "claude-sonnet-5" }] });
    installApi({ machineIds: ["hp_new"] });

    await ensureHarnessPresetOnBrain("hp_new");
    expect(flush).toHaveBeenCalledWith(HARNESS_PRESETS_SETTING_KEY);
  });

  it("says it cannot vouch for a launch running on another computer", async () => {
    // The account settings service is local-runtime-backed: this client can
    // neither read nor write that machine's cache, so claiming the preset is
    // there would be a guess.
    rootAppStoreApi.setState({ harnessPresets: [preset("hp_new")] });
    const api = installApi({ machineIds: [] });

    const result = await ensureHarnessPresetOnBrain("hp_new", { targetsAnotherMachine: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("another computer");
    expect(api.list).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("asks for nothing when the choice is an ad-hoc route", async () => {
    const routeId = encodeRoutePresetId({
      harness: "claude",
      source: { kind: "key", provider: "deepseek", credentialId: "work", label: "Work key" },
      model: "deepseek-v4.1-flash",
    });
    const api = installApi({ machineIds: [] });

    await expect(ensureHarnessPresetOnBrain(routeId)).resolves.toEqual({ ok: true, message: null });
    expect(api.list).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("refuses to push a list that cannot contain the preset", async () => {
    rootAppStoreApi.setState({ harnessPresets: [preset("hp_other")] });
    const api = installApi({ machineIds: [] });

    const result = await ensureHarnessPresetOnBrain("hp_new");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not saved on this computer");
    expect(api.list).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not block a launch when the brain cannot be asked", async () => {
    // An unreadable cache is "we don't know", never "it is missing": pushing
    // on a guess would overwrite a list this machine has not read. A bridge
    // that THROWS is the same answer, and it must not escape either — every
    // caller runs this as a best-effort step before a launch or a batch item.
    for (const list of [
      async () => ({ ok: false as const, unavailable: true as const, message: "no brain" }),
      async () => { throw new Error("the bridge went away"); },
    ]) {
      rootAppStoreApi.setState({ harnessPresets: [preset("hp_new")] });
      const api = installApi({ machineIds: [] });
      api.list.mockImplementation(list as typeof api.list);
      await expect(ensureHarnessPresetOnBrain("hp_new")).resolves.toEqual({ ok: true, message: null });
      expect(flush).not.toHaveBeenCalled();
    }
  });
});
