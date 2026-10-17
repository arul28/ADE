import { describe, expect, it } from "vitest";

import {
  modelOnlyRunsInOpenCode,
  resolveHarnessRoute,
  routeForListedModel,
  type HarnessRouteSource,
  type RouteEndpoints,
} from "./harnessRoutes";

/**
 * The one route decision every surface shares — the wizard's listing, a launch
 * and the Test button. These pin the two rules that keep it honest: a
 * subscription sign-in and a genuine free-tier model answer only inside
 * OpenCode, while the paid model on the same sign-in still routes.
 */

const OPENAI_ENDPOINTS: RouteEndpoints = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
};
const ZEN_ENDPOINTS: RouteEndpoints = {
  anthropic: "https://opencode.ai/inference/anthropic",
  "openai-chat": "https://opencode.ai/inference/openai/v1",
  "openai-responses": "https://opencode.ai/inference/openai/v1",
};

const OPENAI_SIGN_IN = { kind: "opencode", providerId: "openai" } as const;
const ZEN_SIGN_IN = { kind: "opencode", providerId: "opencode" } as const;

describe("modelOnlyRunsInOpenCode", () => {
  it.each([
    ["opencode", "cat-jam-free", true],
    ["opencode", "big-pickle", true],
    ["opencode", "gpt-6-luna", false],
    ["opencode-go", "big-pickle", false],
    ["openai", "big-pickle", false],
  ])("%s / %s → %s", (provider, model, expected) => {
    expect(modelOnlyRunsInOpenCode(provider, model)).toBe(expected);
  });

  it("matches the measured id however it is spelled", () => {
    expect(modelOnlyRunsInOpenCode("opencode", "  BIG-PICKLE  ")).toBe(true);
  });
});

describe("resolveHarnessRoute", () => {
  it("refuses a subscription sign-in outside OpenCode, with a reason", () => {
    const route = resolveHarnessRoute({
      harness: "claude",
      source: OPENAI_SIGN_IN,
      modelId: "gpt-6-luna",
      endpoints: OPENAI_ENDPOINTS,
      sourceSignInKind: "oauth",
    });
    expect(route.kind).toBe("impossible");
    const reason = route.kind === "impossible" ? route.reason : "";
    expect(reason.trim().length).toBeGreaterThan(0);
  });

  it("keeps the same sign-in usable as a key and inside OpenCode", () => {
    expect(
      resolveHarnessRoute({
        harness: "claude",
        source: OPENAI_SIGN_IN,
        modelId: "gpt-6-luna",
        endpoints: OPENAI_ENDPOINTS,
        sourceSignInKind: "key",
      }).kind,
    ).toBe("proxy");
    expect(
      resolveHarnessRoute({
        harness: "opencode",
        source: OPENAI_SIGN_IN,
        modelId: "gpt-6-luna",
        sourceSignInKind: "oauth",
      }).kind,
    ).toBe("native");
  });

  it("refuses a genuine free-tier model outside OpenCode but keeps it inside", () => {
    expect(
      resolveHarnessRoute({ harness: "claude", source: ZEN_SIGN_IN, modelId: "big-pickle", endpoints: ZEN_ENDPOINTS }).kind,
    ).toBe("impossible");
    expect(
      resolveHarnessRoute({ harness: "opencode", source: ZEN_SIGN_IN, modelId: "big-pickle", endpoints: ZEN_ENDPOINTS }).kind,
    ).toBe("native");
  });

  it("still routes a paid model from the same sign-in", () => {
    expect(
      resolveHarnessRoute({
        harness: "claude",
        source: ZEN_SIGN_IN,
        modelId: "gemini-3.1-pro",
        endpoints: ZEN_ENDPOINTS,
        sourceSignInKind: "oauth",
      }).kind,
    ).toBe("direct");
  });

  it("applies the same rule to a listed model", () => {
    const listedSource: HarnessRouteSource = {
      key: "opencode:openai",
      source: OPENAI_SIGN_IN,
      label: "openai",
      detail: "via your OpenCode sign-in",
      logoProvider: "openai",
      endpoints: OPENAI_ENDPOINTS,
      signInKind: "oauth",
      models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }],
    };
    expect(
      routeForListedModel("claude", listedSource, listedSource.models[0]!).kind,
    ).toBe("impossible");
  });
});
