import { describe, expect, it } from "vitest";
import { buildPublicIssueUrl, type PublicIssueLinkInput } from "./publicIssueLink";

const CLEAN: PublicIssueLinkInput = {
  reference: "abcdef12",
  appVersion: "1.2.60",
  channel: "stable",
  osFamily: "macOS",
};

/** The title and body the link prefills, as a person reads them. */
function readableLink(url: string | null): string {
  if (!url) throw new Error("expected a public issue link");
  const params = new URL(url).searchParams;
  return `${params.get("title") ?? ""}\n${params.get("body") ?? ""}`;
}

describe("buildPublicIssueUrl", () => {
  it("carries only the reference, the version and channel, and the OS family", () => {
    const readable = readableLink(buildPublicIssueUrl(CLEAN));

    expect(readable).toContain("Report reference: abcdef12");
    expect(readable).toContain("ADE version: 1.2.60 (stable)");
    expect(readable).toContain("OS: macOS");
  });

  it.each([
    ["a home path in the version", { appVersion: "/Users/arul/Projects/photon" }, "/Users/arul"],
    ["an email in the version", { appVersion: "arul@example.com" }, "arul@example.com"],
    ["a token in the channel", { channel: ["ghp", "0123456789abcdef0123456789abcdef0123"].join("_") }, "ghp_"],
    ["a path as the OS family", { osFamily: "/Users/arul" as never }, "/Users/arul"],
  ])("drops %s instead of putting it in the public link", (_label, override, leaked) => {
    const url = buildPublicIssueUrl({ ...CLEAN, ...override });

    expect(readableLink(url)).not.toContain(leaked);
    expect(readableLink(url)).toContain("Report reference: abcdef12");
  });

  it.each([
    ["a path", "/Users/arul/Projects/photon/report.md"],
    ["an email", "arul@example.com"],
    ["a token-like string", ["sk", "live", "0123456789abcdef0123456789"].join("_")],
  ])("builds no link at all when the reference is %s", (_label, reference) => {
    expect(buildPublicIssueUrl({ ...CLEAN, reference })).toBeNull();
  });
});
