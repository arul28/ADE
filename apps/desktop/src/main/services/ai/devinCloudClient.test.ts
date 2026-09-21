import { describe, expect, it, vi } from "vitest";

import { createDevinCloudClient } from "./devinCloudClient";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

type FetchImpl = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("devinCloudClient verify on non-enterprise accounts", () => {
  it("verifies a configured org via an org-scoped probe when enterprise listing 403s", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/v3/enterprise/organizations")) {
        return jsonResponse({ detail: "This endpoint requires an enterprise account." }, 403);
      }
      if (url.includes("/v3/organizations/org-mine/sessions")) {
        return jsonResponse({ items: [], end_cursor: null });
      }
      return jsonResponse({ detail: "Not Found" }, 404);
    }) as unknown as FetchImpl;

    const client = createDevinCloudClient({ apiKey: "cog_test", orgId: "org-mine", fetchImpl, logger });
    await expect(client.verify()).resolves.toEqual({ orgName: null });
    await expect(client.listSessions()).resolves.toMatchObject({ items: [] });
  });

  it("rejects a bad org id when enterprise listing 403s", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/v3/enterprise/organizations")) {
        return jsonResponse({ detail: "forbidden" }, 403);
      }
      return jsonResponse({ detail: "Not Found" }, 404);
    }) as unknown as FetchImpl;

    const client = createDevinCloudClient({ apiKey: "cog_test", orgId: "org-bad", fetchImpl, logger });
    await expect(client.verify()).rejects.toThrow(/not visible to this Devin token/);
  });

  it("asks for an org id when enterprise listing 403s and none is configured", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/v3/enterprise/organizations")) {
        return jsonResponse({ detail: "forbidden" }, 403);
      }
      return jsonResponse({ detail: "Not Found" }, 404);
    }) as unknown as FetchImpl;

    const client = createDevinCloudClient({ apiKey: "cog_test", orgId: null, fetchImpl, logger });
    await expect(client.verify()).rejects.toThrow(/Could not determine your Devin org/);
    await expect(client.listSessions()).rejects.toThrow(/Could not determine your Devin org/);
  });
});
