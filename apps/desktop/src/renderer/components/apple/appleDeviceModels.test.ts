import { describe, expect, it } from "vitest";
import {
  appleDeviceModel,
  appleDeviceModelById,
  resolveAppleDeviceModelId,
} from "./appleDeviceModels";

describe("resolveAppleDeviceModelId", () => {
  it("maps iPhone Pro Max names onto the Pro Max body", () => {
    expect(resolveAppleDeviceModelId("iphone", "iPhone 17 Pro Max")).toBe("iphone-18-pro-max");
    expect(resolveAppleDeviceModelId("iphone", "iPhone 16 Pro Max")).toBe("iphone-18-pro-max");
    expect(resolveAppleDeviceModelId("iphone", "iPhone 18 Pro Max")).toBe("iphone-18-pro-max");
  });

  it("maps every other iPhone onto the Pro body", () => {
    expect(resolveAppleDeviceModelId("iphone", "iPhone 17 Pro")).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", "iPhone 15")).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", "iPhone SE (3rd generation)")).toBe("iphone-18-pro");
  });

  it("maps any iPad onto the 13-inch M5 body", () => {
    expect(resolveAppleDeviceModelId("ipad", "iPad Pro 13-inch (M5)")).toBe("ipad-pro-13-m5");
    expect(resolveAppleDeviceModelId("ipad", "iPad Air 11-inch (M3)")).toBe("ipad-pro-13-m5");
    expect(resolveAppleDeviceModelId("ipad", "iPad (10th generation)")).toBe("ipad-pro-13-m5");
  });

  it("falls back by family when the product name is missing or unknown", () => {
    expect(resolveAppleDeviceModelId("iphone", null)).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", "")).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("iphone", "Unknown Simulator")).toBe("iphone-18-pro");
    expect(resolveAppleDeviceModelId("ipad", null)).toBe("ipad-pro-13-m5");
    expect(resolveAppleDeviceModelId("ipad", "something else")).toBe("ipad-pro-13-m5");
  });
});

describe("appleDeviceModel", () => {
  it("returns Vite URLs for each bundled body and never the keyboard accessory", () => {
    const pro = appleDeviceModel("iphone", "iPhone 17 Pro");
    const max = appleDeviceModel("iphone", "iPhone 17 Pro Max");
    const ipad = appleDeviceModel("ipad", "iPad Pro 11-inch");
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
