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

  it.each([
    ["IETF protocol assignment", "192.0.0.1"],
    ["TEST-NET-1", "192.0.2.1"],
    ["TEST-NET-2", "198.51.100.5"],
    ["TEST-NET-3", "203.0.113.10"],
  ])("rejects reserved IPv4 range %s", async (_label, address) => {
    await expect(
      assertSafeWebFetchUrl("https://example.com/docs", () => resolver([address])),
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
    ).resolves.toMatchObject({
      url: expect.objectContaining({ protocol: "https:" }),
    });
  });

  it("returns the pinned address and original host metadata for the network request", async () => {
    await expect(
      assertSafeWebFetchUrl("https://example.com:8443/docs?q=1", () => resolver(["93.184.216.34"])),
    ).resolves.toMatchObject({
      resolvedAddress: "93.184.216.34",
      hostHeader: "example.com:8443",
      servername: "example.com",
      url: expect.objectContaining({
        hostname: "example.com",
        pathname: "/docs",
        search: "?q=1",
      }),
    });
  });
});
