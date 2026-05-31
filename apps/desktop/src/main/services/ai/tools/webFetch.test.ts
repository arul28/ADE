/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { assertSafeWebFetchUrl } from "./webFetch";

describe("webFetch SSRF guard", () => {
  const resolver = async (addresses: string[]) => addresses;

  it.each([
    "ftp://example.com/file.txt",
    "http://user:pass@example.com/",
    "not a url",
  ])("rejects unsupported URL input: %s", async (url) => {
    await expect(assertSafeWebFetchUrl(url, () => resolver(["93.184.216.34"]))).rejects.toThrow();
  });

  it.each([
    ["localhost", "http://localhost:3000/"],
    ["loopback IPv4", "http://127.0.0.1/"],
    ["link-local metadata IPv4", "http://169.254.169.254/latest/meta-data/"],
    ["private IPv4", "http://10.0.0.5/"],
    ["private IPv6", "http://[fc00::1]/"],
    ["loopback IPv6", "http://[::1]/"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
  ])("rejects %s targets", async (_label, url) => {
    await expect(assertSafeWebFetchUrl(url, () => resolver(["93.184.216.34"]))).rejects.toThrow(/not allowed|non-public/i);
  });

  it("rejects hostnames when any resolved address is non-public", async () => {
    await expect(
      assertSafeWebFetchUrl("https://example.com/docs", () => resolver(["93.184.216.34", "10.0.0.4"])),
    ).rejects.toThrow(/non-public/);
  });

  it("rejects hostnames with no resolved addresses", async () => {
    await expect(
      assertSafeWebFetchUrl("https://empty.example/docs", () => resolver([])),
    ).rejects.toThrow(/did not resolve/);
  });

  it("allows http and https URLs that resolve only to public addresses", async () => {
    await expect(
      assertSafeWebFetchUrl("https://example.com/docs", () => resolver(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])),
    ).resolves.toMatchObject({ protocol: "https:" });
  });
});
