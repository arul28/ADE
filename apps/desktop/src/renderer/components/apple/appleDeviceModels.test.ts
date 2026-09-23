import { describe, expect, it } from "vitest";
import {
  appleDeviceModel,
  appleDeviceModelById,
  resolveAppleDeviceModelId,
} from "./appleDeviceModels";

describe("resolveAppleDeviceModelId", () => {
  it("reads the CoreSimulator type id, not the name a person chose", () => {
    // ADE names a clone after its lane, so a real Pro Max in a lane is called
    // something like "apple sim preview" and matched nothing — every Pro Max
    // rendered on the smaller Pro body.
    expect(
      resolveAppleDeviceModelId("iphone", {
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
        deviceTypeName: "apple sim preview",
      }),
    ).toBe("iphone-18-pro-max");

    // And the reverse: a plain iPhone somebody named "Pro Max test" is not a Max.
    expect(
      resolveAppleDeviceModelId("iphone", {
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        deviceTypeName: "Pro Max test",
      }),
    ).toBe("iphone-18-pro");
  });

  it("maps iPhone Pro Max names onto the Pro Max body", () => {
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "iPhone 17 Pro Max" })).toBe("iphone-18-pro-max");
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "iPhone 16 Pro Max" })).toBe("iphone-18-pro-max");
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "iPhone 18 Pro Max" })).toBe("iphone-18-pro-max");
  });

  it("maps every other iPhone onto the Pro body", () => {
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "iPhone 17 Pro" })).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "iPhone 15" })).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "iPhone SE (3rd generation)" })).toBe("iphone-18-pro");
  });

  it("maps any iPad onto the 13-inch M5 body", () => {
    expect(resolveAppleDeviceModelId("ipad", { deviceTypeName: "iPad Pro 13-inch (M5)" })).toBe("ipad-pro-13-m5");
    expect(resolveAppleDeviceModelId("ipad", { deviceTypeName: "iPad Air 11-inch (M3)" })).toBe("ipad-pro-13-m5");
    expect(resolveAppleDeviceModelId("ipad", { deviceTypeName: "iPad (10th generation)" })).toBe("ipad-pro-13-m5");
  });

  it("falls back by family when the product name is missing or unknown", () => {
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: null })).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "" })).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", { deviceTypeName: "Unknown Simulator" })).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("ipad", { deviceTypeName: null })).toBe("ipad-pro-13-m5");
    expect(resolveAppleDeviceModelId("ipad", { deviceTypeName: "something else" })).toBe("ipad-pro-13-m5");
  });
});

describe("appleDeviceModel", () => {
  it("returns Vite URLs for each bundled body and never the keyboard accessory", () => {
    const pro = appleDeviceModel("iphone", { deviceTypeName: "iPhone 17 Pro" });
    const max = appleDeviceModel("iphone", { deviceTypeName: "iPhone 17 Pro Max" });
    const ipad = appleDeviceModel("ipad", { deviceTypeName: "iPad Pro 11-inch" });
    expect(pro.id).toBe("iphone-18-pro");
    expect(max.id).toBe("iphone-18-pro-max");
    expect(ipad.id).toBe("ipad-pro-13-m5");
    expect(pro.url).toMatch(/iphone-18-pro/);
    expect(max.url).toMatch(/iphone-18-pro-max/);
    expect(ipad.url).toMatch(/ipad-pro-13-m5/);
    expect(pro.url).not.toMatch(/magic-keyboard/);
    expect(appleDeviceModelById("iphone-18-pro").url).toBe(pro.url);
  });
});
