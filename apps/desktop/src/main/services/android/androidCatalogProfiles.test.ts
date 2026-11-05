import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ANDROID_DEVICE_CATALOG } from "../../../shared/androidDeviceCatalog";
import { writeAndroidAdeProfile } from "./androidCatalogProfiles";

/*
 * ADE adds its hardware profile to the person's own `devices.xml`, which
 * Android Studio also reads and writes. Their profiles, and the file's line
 * endings, must survive every write.
 */

const USER_DEVICES_CRLF = [
  "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
  "<d:devices xmlns:d=\"http://schemas.android.com/sdk/devices/7\">",
  "  <d:device>",
  "    <d:name>My Test Phone</d:name>",
  "    <d:id>my_test_phone</d:id>",
  "  </d:device>",
  "</d:devices>",
  "",
].join("\r\n");

describe("writeAndroidAdeProfile", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-devices-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("keeps the person's profiles and line endings, writes ADE's once, and leaves a foreign file alone", () => {
    const spec = ANDROID_DEVICE_CATALOG.find((entry) => entry.adeProfile)?.adeProfile;
    if (!spec) throw new Error("setup: the catalog has no ADE-written profile");
    const file = path.join(home, "devices.xml");
    fs.writeFileSync(file, USER_DEVICES_CRLF);

    expect(writeAndroidAdeProfile(home, spec)).toBeNull();
    const written = fs.readFileSync(file, "utf8");
    expect(written).toContain("  <d:device>\r\n    <d:name>My Test Phone</d:name>\r\n    <d:id>my_test_phone</d:id>\r\n  </d:device>");
    expect(written.split(`<d:id>${spec.id}</d:id>`)).toHaveLength(2);
    expect(written).not.toMatch(/(?<!\r)\n/u);

    // A second write (the next create) changes nothing and adds no copy.
    expect(writeAndroidAdeProfile(home, spec)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(written);

    // A file that is not a device list is never rewritten.
    fs.writeFileSync(file, "not a device list");
    expect(writeAndroidAdeProfile(home, spec)).not.toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("not a device list");
    expect(fs.readdirSync(home)).toEqual(["devices.xml"]);
  });
});
