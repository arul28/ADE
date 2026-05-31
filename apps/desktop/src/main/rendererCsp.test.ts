import { describe, expect, it } from "vitest";
import { buildRendererCspPolicy } from "./rendererCsp";

describe("buildRendererCspPolicy", () => {
  it("allows packaged renderer fetches to local simulator stream URLs without blanket HTTPS", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("connect-src 'self' file: app: http://localhost:* http://127.0.0.1:*");
    expect(policy).not.toContain("connect-src 'self' file: app: http://localhost:* http://127.0.0.1:* https:");
  });

  it("keeps dev websocket sources for Vite while allowing local fetches", () => {
    const policy = buildRendererCspPolicy(true);

    expect(policy).toContain("connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*");
    expect(policy).not.toContain("connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https:");
  });

  it("drops inline script permission from packaged renderer policy", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("script-src 'self' file: app:");
    expect(policy).not.toContain("script-src 'self' file: app: 'unsafe-inline'");
  });

  it("keeps inline script permission only for Vite dev preambles", () => {
    const policy = buildRendererCspPolicy(true);

    expect(policy).toContain("script-src 'self' http://localhost:* http://127.0.0.1:* 'unsafe-inline'");
  });

  it("frames built-in browser content from local servers and about:blank in packaged builds", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("frame-src 'self' file: app: http://localhost:* http://127.0.0.1:* about:");
  });

  it("does not allow arbitrary public Google Cloud Storage image beacons", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("img-src");
    expect(policy).not.toContain("https://storage.googleapis.com");
  });
});
