import { describe, expect, it } from "vitest";
import { buildRendererCspPolicy, shouldApplyRendererCsp } from "./rendererCsp";

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

  it("allows only the welcome video YouTube embed hosts for external frames", () => {
    const policy = buildRendererCspPolicy(false);
    const frameSrc = policy.split("; ").find((directive) => directive.startsWith("frame-src "));
    const frameTokens = frameSrc?.split(/\s+/).slice(1) ?? [];
    const externalFrameTokens = frameTokens.filter((token) => token.startsWith("https://"));

    expect(externalFrameTokens).toEqual([
      "https://www.youtube-nocookie.com",
      "https://www.youtube.com",
    ]);
    expect(frameTokens).not.toContain("https:");
  });

  it("does not allow arbitrary public Google Cloud Storage image beacons", () => {
    const policy = buildRendererCspPolicy(false);

    expect(policy).toContain("img-src");
    expect(policy).not.toContain("https://storage.googleapis.com");
  });
});

describe("shouldApplyRendererCsp", () => {
  it("applies the renderer policy to packaged ADE documents", () => {
    expect(
      shouldApplyRendererCsp(
        { url: "file:///Applications/ADE/index.html", resourceType: "mainFrame" },
        { isDevMode: false },
      ),
    ).toBe(true);
    expect(
      shouldApplyRendererCsp(
        { url: "app://ade/index.html", resourceType: "mainFrame" },
        { isDevMode: false },
      ),
    ).toBe(true);
  });

  it("applies the renderer policy only to the active Vite origin in dev", () => {
    const options = { isDevMode: true, devServerUrl: "http://localhost:5173" };

    expect(
      shouldApplyRendererCsp(
        { url: "http://localhost:5173/work", resourceType: "mainFrame" },
        options,
      ),
    ).toBe(true);
    expect(
      shouldApplyRendererCsp(
        { url: "http://localhost:5174/work", resourceType: "mainFrame" },
        options,
      ),
    ).toBe(false);
  });

  it("does not overwrite external subframe CSP headers", () => {
    expect(
      shouldApplyRendererCsp(
        {
          url: "https://www.youtube-nocookie.com/embed/64E0pViEiB8",
          resourceType: "subFrame",
        },
        { isDevMode: false },
      ),
    ).toBe(false);
  });

  it("does not apply without an explicit main-frame resource type", () => {
    expect(
      shouldApplyRendererCsp(
        { url: "file:///Applications/ADE/index.html" },
        { isDevMode: false },
      ),
    ).toBe(false);
  });
});
