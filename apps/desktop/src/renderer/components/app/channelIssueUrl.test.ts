import { describe, expect, it } from "vitest";

import type { AppInfo } from "../../../shared/types/core";
import {
  MAX_ISSUE_URL_LENGTH,
  buildChannelIssueBody,
  buildChannelIssueUrl,
} from "./channelIssueUrl";

function appInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    appVersion: "1.2.51",
    packageChannel: "beta",
    isPackaged: true,
    automationsEnabled: true,
    platform: "win32",
    arch: "x64",
    versions: {
      electron: "33.2.0",
      chrome: "130.0.6723.44",
      node: "20.18.0",
      v8: "13.0.245.18",
    },
    env: {},
    localRuntime: null,
    ...overrides,
  };
}

describe("buildChannelIssueUrl", () => {
  it("prefills the version and channel", () => {
    const url = buildChannelIssueUrl({
      appInfo: appInfo(),
      channel: "beta",
      osRelease: "Windows 11 (platformVersion 15.0.0)",
    });
    const params = new URL(url).searchParams;
    expect(params.get("body")).toContain("ADE version: 1.2.51");
    expect(params.get("body")).toContain("Package channel: beta");
    expect(params.get("title")).toBe("[beta 1.2.51 win32] ");
  });

  it("carries the platform, arch, OS release and runtime versions", () => {
    const decoded = new URL(
      buildChannelIssueUrl({
        appInfo: appInfo(),
        channel: "beta",
        osRelease: "Windows 11 (platformVersion 15.0.0)",
      }),
    ).searchParams.get("body") ?? "";
    expect(decoded).toContain("Platform: win32 (x64)");
    expect(decoded).toContain("OS release: Windows 11 (platformVersion 15.0.0)");
    expect(decoded).toContain("Electron: 33.2.0");
    expect(decoded).toContain("Chrome: 130.0.6723.44");
    expect(decoded).toContain("Node: 20.18.0");
  });

  it("targets the repository from build.publish", () => {
    const url = buildChannelIssueUrl({ appInfo: appInfo(), channel: "beta" });
    expect(url.startsWith("https://github.com/arul28/ADE/issues/new?")).toBe(true);
  });

  it("URL-encodes the body rather than emitting raw newlines", () => {
    const url = buildChannelIssueUrl({ appInfo: appInfo(), channel: "beta" });
    expect(url).not.toContain("\n");
    expect(url).toContain("body=");
    expect(new URL(url).searchParams.get("body")).toContain("ADE version: 1.2.51");
  });

  it("still labels the channel when AppInfo has not arrived", () => {
    const decoded = new URL(
      buildChannelIssueUrl({ appInfo: null, channel: "alpha", osRelease: null }),
    ).searchParams.get("body") ?? "";
    expect(decoded).toContain("Package channel: alpha");
    expect(decoded).toContain("ADE version: unknown");
    expect(decoded).toContain("OS release: unknown");
  });

  it("stays under the GitHub length ceiling even with absurd inputs", () => {
    const url = buildChannelIssueUrl({
      appInfo: appInfo({ appVersion: "1.2.51" }),
      channel: "beta",
      osRelease: "\n".repeat(20000),
    });
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
  });

  it("keeps the normal report comfortably short", () => {
    const url = buildChannelIssueUrl({
      appInfo: appInfo(),
      channel: "beta",
      osRelease: "Windows 11 (platformVersion 15.0.0)",
    });
    expect(url.length).toBeLessThan(1500);
  });
});

describe("buildChannelIssueBody", () => {
  it("marks unknown fields instead of emitting empty rows", () => {
    const body = buildChannelIssueBody({ appInfo: null, channel: "beta" });
    expect(body).toContain("- Electron: unknown");
    expect(body).toContain("### Steps to reproduce");
  });
});
