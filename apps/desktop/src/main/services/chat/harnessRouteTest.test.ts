import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The credential store is the process boundary; the source resolver reads a
// stored key through it. Mocking it keeps this test off the developer's real
// key store while still exercising the real resolve → probe → route path.
vi.mock("../ai/apiKeyStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/apiKeyStore")>()),
  getApiCredentialSummary: vi.fn(() => ({
    provider: "deepseek",
    credentialId: "work",
    label: "Work key",
    source: "store" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  getApiCredentialKey: vi.fn(() => "sk-test-deepseek"),
}));

import { testHarnessRoute } from "./harnessRouteTest";

type Fetch = typeof fetch;

let adeHome = "";

beforeEach(() => {
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-route-test-"));
});

afterEach(() => {
  fs.rmSync(adeHome, { recursive: true, force: true });
});

describe("testHarnessRoute", () => {
  it("records a hang as a definite no and routes around it", async () => {
    const requestedUrls: string[] = [];
    // The Anthropic endpoint accepts the request and never answers; the OpenAI
    // chat endpoint answers 200. The hang must be recorded as a definite no so
    // the Test keeps trying and lands the one that works — the wedged protocol
    // is the worse failure to leave standing, because a launch on it hangs with
    // no error at all.
    const hangingAnthropicThenOkFetch: Fetch = (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/anthropic/")) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => "{}" } as unknown as Response);
    };

    const result = await testHarnessRoute(
      {
        harness: "claude",
        source: { kind: "key", provider: "deepseek", credentialId: "work", label: "Work key" },
        model: "deepseek-chat",
      },
      { adeHome, fetchImpl: hangingAnthropicThenOkFetch, timeoutMs: 25 },
    );

    expect(result).toMatchObject({ ok: true, protocol: "openai-chat", route: "proxy" });
    expect(requestedUrls.some((url) => url.includes("api.deepseek.com/anthropic"))).toBe(true);

    const probes = JSON.parse(
      fs.readFileSync(path.join(adeHome, "cache", "harness-route-probes.json"), "utf8"),
    ) as { entries: Record<string, { verdict: Record<string, boolean> }> };
    const verdicts = Object.values(probes.entries);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.verdict).toMatchObject({ anthropic: false, "openai-chat": true });
  });
});
