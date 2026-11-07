import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AndroidSettingsFileBrokenError,
  createAndroidMachinePreferenceStore,
  createAndroidSettingsFile,
} from "./androidMachinePreferences";

// The settings file holds the SDK folder (`sdkPath`) next to the preferences.
// Losing it sends the person back through the SDK setup.
describe("the machine's Android settings file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-settings-"));
    file = path.join(dir, "settings.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps sdkPath and another writer's change when the preferences change", () => {
    fs.writeFileSync(file, JSON.stringify({ sdkPath: "/Volumes/Dev/Android/Sdk", preferences: { tapRings: true } }));
    const store = createAndroidMachinePreferenceStore(createAndroidSettingsFile(file));
    expect(store.read().tapRings).toBe(true);

    // A second writer (the SDK setup, a second brain) changes the file after this store read it.
    createAndroidSettingsFile(file).writeKeys((body) => ({
      preferences: { ...(body.preferences as Record<string, unknown>), tapRings: false },
    }));

    const written = store.write({ keyBadges: false });

    expect(written).toMatchObject({ tapRings: false, keyBadges: false });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.sdkPath).toBe("/Volumes/Dev/Android/Sdk");
    expect(onDisk.preferences).toMatchObject({ tapRings: false, keyBadges: false });
  });

  it.each([
    ["is not valid JSON", (at: string) => fs.writeFileSync(at, "{\"sdkPath\": \"/sdk\",")],
    ["is not a JSON object", (at: string) => fs.writeFileSync(at, "[\"/sdk\"]")],
    // EISDIR on every platform: a read error that is not ENOENT.
    ["cannot be read", (at: string) => fs.mkdirSync(at)],
  ])("refuses to write over a file that %s, and leaves it as it was", (_label, breakFile) => {
    breakFile(file);
    const before = fs.statSync(file).isDirectory() ? "dir" : fs.readFileSync(file, "utf8");
    const store = createAndroidMachinePreferenceStore(createAndroidSettingsFile(file));

    // A broken file reads as the defaults, so the page still opens.
    expect(store.read().tapRings).toBe(true);
    expect(() => store.write({ tapRings: false })).toThrow(AndroidSettingsFileBrokenError);
    const after = fs.statSync(file).isDirectory() ? "dir" : fs.readFileSync(file, "utf8");
    expect(after).toBe(before);
  });
});
