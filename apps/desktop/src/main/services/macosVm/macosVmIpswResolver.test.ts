import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseMacosIpswManifest,
  parseSoftwareUpdateList,
  probeMacosIpswHostState,
  resolveMacosIpsw,
} from "./macosVmIpswResolver";

const fixtureXml = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "macos_ipsw_mesu_fixture.xml"),
  "utf8",
);

function commandResult(stdout = "") {
  return { exitCode: 0, signal: null, stdout, stderr: "" };
}

describe("macosVmIpswResolver", () => {
  it("parses pending macOS update builds from softwareupdate output", () => {
    const parsed = parseSoftwareUpdateList(
      [
        "Software Update Tool",
        "* Label: macOS Tahoe 26.4.1-25E253",
        "\tTitle: macOS Tahoe 26.4.1, Version: 26.4.1, Size: 7290000K, Recommended: YES",
      ].join("\n"),
      "25D125",
      "Mac16,1",
    );

    expect(parsed).toEqual({
      pendingBuild: "25E253",
      pendingProductVersion: "26.4.1",
      currentBuild: "25D125",
      model: "Mac16,1",
    });
  });

  it("probes current build, model, and pending update without requiring sudo", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "sw_vers" && args.includes("-buildVersion")) return commandResult("25D125\n");
      if (command === "sysctl" && args.includes("hw.model")) return commandResult("Mac16,1\n");
      if (command === "softwareupdate") return commandResult("* Label: macOS Tahoe 26.4.1-25E253\n");
      return commandResult();
    });

    const probe = await probeMacosIpswHostState(runCommand);

    expect(probe.pendingBuild).toBe("25E253");
    expect(probe.currentBuild).toBe("25D125");
    expect(probe.model).toBe("Mac16,1");
    expect(runCommand).toHaveBeenCalledWith("softwareupdate", ["-l", "--no-scan"], { timeoutMs: 60000 });
  });

  it("parses mesu manifest entries and groups shared IPSW URLs by supported models", () => {
    const entries = parseMacosIpswManifest(fixtureXml);

    const tahoe = entries.find((entry) => entry.build === "25E253");
    expect(tahoe).toMatchObject({
      productVersion: "26.4.1",
      firmwareUrl: "https://updates.cdn-apple.com/macOS-26.4.1-25E253.ipsw",
    });
    expect(tahoe?.supportedDeviceModels).toEqual(["Mac15,3", "Mac16,1"]);
  });

  it("prefers the pending host build, then enriches the result with Content-Length", async () => {
    const resolved = await resolveMacosIpsw(
      {
        pendingBuild: "25E253",
        pendingProductVersion: "26.4.1",
        currentBuild: "25D125",
        model: "Mac16,1",
      },
      {
        fetchText: async () => fixtureXml,
        fetchContentLength: async () => 17_300_000_000,
      },
    );

    expect(resolved).toMatchObject({
      build: "25E253",
      productVersion: "26.4.1",
      sizeBytes: 17_300_000_000,
      source: "pending-build",
      url: "https://updates.cdn-apple.com/macOS-26.4.1-25E253.ipsw",
    });
    expect(resolved?.alternatives.some((entry) => entry.build === "25D125")).toBe(true);
  });
});
