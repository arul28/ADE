import { describe, expect, it, vi } from "vitest";
// The desktop client's copy of the contract. It is Node-free on purpose, so
// the Worker suite can import it and hold the two copies to each other.
import * as client from "../../desktop/src/shared/usageResearch";
import { utcDayKey } from "../src/sinkUtils";
import * as server from "../src/usageResearch";
import { FakeD1Database } from "./fakeD1";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function body(overrides: Partial<client.UsageResearchDailyBody> = {}): client.UsageResearchDailyBody {
  return {
    schemaVersion: client.USAGE_RESEARCH_SCHEMA_VERSION,
    installId: "0".repeat(32),
    day: "2026-09-22",
    appVersion: "1.2.78",
    platform: "darwin",
    arch: "arm64",
    utcOffsetMinutes: 0,
    report: { totals: { turns: 1, apiEquivalentUsd: 0, providerCostUsd: 0, listPriceCostUsd: 0 }, groups: [], quota: [], burnRates: [], prices: {} },
    ...overrides,
  };
}

async function post(json: string): Promise<Response> {
  const url = client.usageResearchDailyUrl("https://directory.test/");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    return await server.handleUsageResearchRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.1" },
        body: json,
      }),
      { DB: new FakeD1Database() as unknown as D1Database },
      { now: () => NOW },
    );
  } finally {
    log.mockRestore();
  }
}

describe("usage research contract (desktop client vs Worker)", () => {
  it("names the same path, schema version, caps, id shape, and error codes", () => {
    expect(client.USAGE_RESEARCH_DAILY_PATH).toBe(server.USAGE_RESEARCH_DAILY_PATH);
    expect(server.isUsageResearchRequest(new URL(client.usageResearchDailyUrl("https://directory.test/")))).toBe(true);
    expect(client.USAGE_RESEARCH_SCHEMA_VERSION).toBe(server.USAGE_RESEARCH_SCHEMA_VERSION);
    expect(client.MAX_USAGE_RESEARCH_BODY_BYTES).toBe(server.MAX_USAGE_RESEARCH_BODY_BYTES);
    expect(client.MAX_USAGE_RESEARCH_APP_VERSION_CHARS).toBe(server.MAX_USAGE_RESEARCH_APP_VERSION_CHARS);
    expect(client.MAX_USAGE_RESEARCH_PLATFORM_CHARS).toBe(server.MAX_USAGE_RESEARCH_PLATFORM_CHARS);
    // The client cuts `arch` with the platform cap.
    expect(client.MAX_USAGE_RESEARCH_PLATFORM_CHARS).toBe(server.MAX_USAGE_RESEARCH_ARCH_CHARS);
    expect(client.MAX_USAGE_RESEARCH_UTC_OFFSET_MINUTES).toBe(server.MAX_USAGE_RESEARCH_UTC_OFFSET_MINUTES);
    expect(client.USAGE_RESEARCH_INSTALL_ID_PATTERN.source).toBe(server.USAGE_RESEARCH_INSTALL_ID_PATTERN.source);
    expect(client.USAGE_RESEARCH_IDENTITY_LIMIT_ERROR).toBe(server.USAGE_RESEARCH_ERRORS.identityLimit);
    expect(client.USAGE_RESEARCH_DAILY_LIMIT_ERROR).toBe(server.USAGE_RESEARCH_ERRORS.dailyLimit);
    expect(client.USAGE_RESEARCH_STORAGE_FULL_ERROR).toBe(server.USAGE_RESEARCH_ERRORS.storageFull);
    expect(client.USAGE_RESEARCH_UNAVAILABLE_ERROR).toBe(server.USAGE_RESEARCH_ERRORS.unavailable);
  });

  it("accepts every day the client may send, from every time zone at every hour", () => {
    // The client sends local days from today − MAX_DAYS_BACK to yesterday.
    for (let hour = 0; hour < 24; hour += 1) {
      const nowMs = Date.UTC(2026, 8, 23, hour, 30);
      const accepted = server.acceptedUsageResearchDays(nowMs);
      const maxOffset = client.MAX_USAGE_RESEARCH_UTC_OFFSET_MINUTES;
      for (let offset = -12 * 60; offset <= maxOffset; offset += 15) {
        const localToday = nowMs + offset * 60_000;
        for (let back = 1; back <= client.USAGE_RESEARCH_MAX_DAYS_BACK; back += 1) {
          const day = utcDayKey(localToday - back * DAY_MS);
          expect({ hour, offset, back, inside: day >= accepted.earliest && day <= accepted.latest })
            .toEqual({ hour, offset, back, inside: true });
        }
      }
    }
    // Retention never sweeps a day the route still accepts.
    expect(server.MIN_USAGE_RESEARCH_RETENTION_DAYS * DAY_MS).toBeGreaterThan(
      server.USAGE_RESEARCH_MAX_REPORT_AGE_DAYS * DAY_MS + 12 * HOUR_MS,
    );
  });

  it("stores a body at every client cap, and refuses one byte past the body cap", async () => {
    const atCaps = body({
      appVersion: client.usageResearchEnvelopeText("9".repeat(200), client.MAX_USAGE_RESEARCH_APP_VERSION_CHARS),
      platform: client.usageResearchEnvelopeText("p".repeat(200), client.MAX_USAGE_RESEARCH_PLATFORM_CHARS),
      arch: client.usageResearchEnvelopeText("a".repeat(200), client.MAX_USAGE_RESEARCH_PLATFORM_CHARS),
      utcOffsetMinutes: client.usageResearchUtcOffset(-100_000),
    });
    const empty = JSON.stringify({ ...atCaps, report: { ...atCaps.report, pad: "" } });
    const pad = "x".repeat(client.MAX_USAGE_RESEARCH_BODY_BYTES - new TextEncoder().encode(empty).byteLength);
    const full = JSON.stringify({ ...atCaps, report: { ...atCaps.report, pad } });
    expect(new TextEncoder().encode(full).byteLength).toBe(client.MAX_USAGE_RESEARCH_BODY_BYTES);
    expect((await post(full)).status).toBe(201);

    const over = JSON.stringify({ ...atCaps, report: { ...atCaps.report, pad: `${pad}x` } });
    const refused = await post(over);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: server.USAGE_RESEARCH_ERRORS.tooLarge });

    const pastCap = await post(JSON.stringify(body({ appVersion: "9".repeat(client.MAX_USAGE_RESEARCH_APP_VERSION_CHARS + 1) })));
    expect(pastCap.status).toBe(400);
    expect(await pastCap.json()).toEqual({ error: server.USAGE_RESEARCH_ERRORS.invalid });
  });
});
