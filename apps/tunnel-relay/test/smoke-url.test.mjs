import { describe, expect, it } from "vitest";
import { requireLoopbackRelayUrl } from "./smoke-url.mjs";

describe("manual smoke target", () => {
  it.each([
    "http://127.0.0.1:8787",
    "http://127.42.0.8:8787/",
    "http://localhost:8787",
    "http://[::1]:8787",
  ])("allows loopback URL %s", (url) => {
    expect(requireLoopbackRelayUrl(url)).toBe(url.replace(/\/+$/, ""));
  });

  it.each([
    "https://ade-tunnel-relay.example.workers.dev",
    "http://localhost.example.com:8787",
    "http://192.168.1.2:8787",
    "ws://127.0.0.1:8787",
  ])("refuses non-loopback or non-HTTP URL %s", (url) => {
    expect(() => requireLoopbackRelayUrl(url)).toThrow(/local-only; refusing/);
  });
});
