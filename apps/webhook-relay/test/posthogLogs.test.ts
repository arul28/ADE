import { afterEach, describe, expect, it, vi } from "vitest";
import { reportRequest } from "../src/posthogLogs";

// `posthogLogs.ts` is byte-identical in all four Workers; this pins the
// privacy contract of what one request record may carry.
describe("PostHog Logs request records", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["a repository owner and name", "/github/repos/acme-corp/secret-widgets/events", "/github/repos/:id/:id/events", ["acme-corp", "secret-widgets"]],
    ["a key after a key-carrying route", "/connect/abcdef1234567890?token=t0ps3cr3t", "/connect/:id", ["abcdef1234567890", "t0ps3cr3t"]],
    ["a machine id", "/machines/m-7f3a/state", "/machines/:id", ["m-7f3a"]],
  ])("logs only the route template, never %s", async (_label, path, template, secrets) => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending: Promise<unknown>[] = [];

    // A 5xx is always sampled, so the record is sent.
    reportRequest(
      { POSTHOG_LOGS_TOKEN: "", POSTHOG_PROJECT_TOKEN: "phc_publictesttokenpublictoken12", SENTRY_RELEASE: "ade@1.2.130" },
      { waitUntil: (promise) => pending.push(promise) },
      "ade-github-webhook-relay",
      new Request(`https://relay.example${path}`, { method: "POST", headers: { authorization: "Bearer user-secret" } }),
      503,
      Date.now(),
    );
    await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/i/v1/logs");
    const body = String(init.body);
    const record = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords[0];
    const attributes = Object.fromEntries(
      record.attributes.map((attribute: { key: string; value: Record<string, unknown> }) => [attribute.key, Object.values(attribute.value)[0]]),
    );
    expect(attributes).toMatchObject({ event: "request_completed", route: template, status: "503", method: "POST" });
    for (const secret of [...secrets, "user-secret", "relay.example"]) {
      expect(body).not.toContain(secret);
    }
  });
});
