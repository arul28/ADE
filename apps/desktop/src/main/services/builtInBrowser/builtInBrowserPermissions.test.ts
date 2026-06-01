import { describe, expect, it } from "vitest";
import {
  shouldAllowGoogleAuthPermissionCheck,
  shouldAllowGoogleAuthPermissionRequest,
} from "./builtInBrowserPermissions";

describe("builtInBrowserPermissions", () => {
  it("allows Google auth storage permission checks from known Google account surfaces", () => {
    expect(shouldAllowGoogleAuthPermissionCheck("storage-access", "https://accounts.google.com", {
      requestingUrl: "https://example.com",
      embeddingOrigin: "",
      securityOrigin: "",
    } as Electron.PermissionCheckHandlerHandlerDetails)).toBe(true);
    expect(shouldAllowGoogleAuthPermissionCheck("usb", "https://example.com", {
      requestingUrl: "https://accounts.google.com/signin",
      embeddingOrigin: "",
      securityOrigin: "",
    } as Electron.PermissionCheckHandlerHandlerDetails)).toBe(true);
  });

  it("denies unsupported permission checks and non-Google origins", () => {
    expect(shouldAllowGoogleAuthPermissionCheck("geolocation", "https://accounts.google.com", {
      requestingUrl: "https://accounts.google.com",
      embeddingOrigin: "",
      securityOrigin: "",
    } as Electron.PermissionCheckHandlerHandlerDetails)).toBe(false);
    expect(shouldAllowGoogleAuthPermissionCheck("storage-access", "https://example.com", {
      requestingUrl: "https://example.com",
      embeddingOrigin: "",
      securityOrigin: "",
    } as Electron.PermissionCheckHandlerHandlerDetails)).toBe(false);
  });

  it("allows only Google auth storage permission requests", () => {
    expect(shouldAllowGoogleAuthPermissionRequest("storage-access", {
      requestingUrl: "https://accounts.google.com/signin",
    })).toBe(true);
    expect(shouldAllowGoogleAuthPermissionRequest("notifications", {
      requestingUrl: "https://accounts.google.com/signin",
    })).toBe(false);
    expect(shouldAllowGoogleAuthPermissionRequest("storage-access", {
      requestingUrl: "https://example.com",
    })).toBe(false);
  });
});
