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

describe("devinCloudClient downloadAttachment", () => {
  const attachment = { attachmentId: "att-1", name: "proof.png", url: "x", source: "devin" as const, contentType: "image/png" };

  const bytesResponse = (bytes: Uint8Array) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  it("refuses attachments whose bytes sniff as markup despite an image name", async () => {
    for (const payload of [
      "\uFEFF<html><body>hi</body></html>",
      "<!-- comment --><svg onload=alert(1)>",
      "<body><script>alert(1)</script>",
      "<?xml version='1.0'?><svg></svg>",
      // `<?` is a bogus comment in HTML and ends at the first `>` — the SVG
      // here is inert, but the smuggled `<script>` after it is not.
      "<?xml <svg><script>alert(1)</script></svg> ?>",
    ]) {
      const fetchImpl = vi.fn(async () => bytesResponse(new TextEncoder().encode(payload)));
      const client = createDevinCloudClient({
        apiKey: "cog_test", orgId: "org-mine", fetchImpl: fetchImpl as never, logger,
      });
      await expect(client.downloadAttachment(attachment)).resolves.toBeNull();
    }
  });

  it("returns bytes for genuine binary content", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fetchImpl = vi.fn(async () => bytesResponse(png));
    const client = createDevinCloudClient({
      apiKey: "cog_test", orgId: "org-mine", fetchImpl: fetchImpl as never, logger,
    });
    await expect(client.downloadAttachment(attachment)).resolves.toEqual(png);
  });

  it("keeps text files that merely mention markup tags inline", async () => {
    for (const payload of [
      "The <body> element contains the result.",
      "<?xml version=\"1.0\"?><plist><dict></dict></plist>",
      "note: see <svg> and <script> tags below",
    ]) {
      const bytes = new TextEncoder().encode(payload);
      const fetchImpl = vi.fn(async () => bytesResponse(bytes));
      const client = createDevinCloudClient({
        apiKey: "cog_test", orgId: "org-mine", fetchImpl: fetchImpl as never, logger,
      });
      await expect(client.downloadAttachment(attachment)).resolves.toEqual(bytes);
    }
  });
});
