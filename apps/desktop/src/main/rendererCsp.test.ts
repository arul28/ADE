import { describe, expect, it } from "vitest";
import { buildRendererCspPolicy } from "./rendererCsp";

describe("buildRendererCspPolicy", () => {
  it("allows packaged renderer fetches to local simulator stream URLs", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("connect-src 'self' file: app: http://localhost:* http://127.0.0.1:* https:");
  });

  it("keeps dev websocket sources for Vite while allowing local fetches", () => {
    const policy = buildRendererCspPolicy(true);

    expect(policy).toContain("connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https:");
  });

  it("frames built-in browser content from local servers and about:blank in packaged builds", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("frame-src 'self' file: app: http://localhost:* http://127.0.0.1:* about:");
  });

  it("allows GitHub PR bot images served from public Google Cloud Storage", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("img-src");
    expect(policy).toContain("https://storage.googleapis.com");
  });
});
