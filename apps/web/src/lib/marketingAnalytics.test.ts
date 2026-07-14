import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MarketingAnalytics,
  MARKETING_ANALYTICS_EVENTS,
  MARKETING_FEATURES,
  MARKETING_SCREENS,
  normalizeMarketingScreen,
  type PostHogCapturePayload,
  type StorageLike,
} from "./marketingAnalytics.ts";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class BlockedStorage implements StorageLike {
  getItem(): string | null {
    throw new Error("storage blocked");
  }

  setItem(): void {
    throw new Error("storage blocked");
  }

  removeItem(): void {
    throw new Error("storage blocked");
  }
}

function createHarness(options: { enabled?: boolean; now?: Date } = {}) {
  const storage = new MemoryStorage();
  const payloads: PostHogCapturePayload[] = [];
  let enabled = options.enabled ?? true;
  let now = options.now ?? new Date("2026-07-13T12:00:00.000Z");
  const analytics = new MarketingAnalytics({
    projectToken: "phc_public_project_token",
    storage,
    isEnabled: () => enabled,
    now: () => now,
    idFactory: () => "stable_analytics_identifier_123",
    transport: (payload) => {
      payloads.push(payload);
    },
  });
  return {
    analytics,
    payloads,
    storage,
    setEnabled(value: boolean) {
      enabled = value;
    },
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

test("normalizes only allowlisted pathnames and ignores the OG renderer", () => {
  assert.equal(normalizeMarketingScreen("/"), MARKETING_SCREENS.HOME);
  assert.equal(normalizeMarketingScreen("/open"), MARKETING_SCREENS.OPEN_LINK);
  assert.equal(normalizeMarketingScreen("/download/"), MARKETING_SCREENS.DOWNLOAD);
  assert.equal(normalizeMarketingScreen("/_og"), null);
  assert.equal(normalizeMarketingScreen("/anything/private"), MARKETING_SCREENS.NOT_FOUND);
});

test("manual payload contains only anonymous allowlisted properties", () => {
  const { analytics, payloads } = createHarness();
  assert.equal(analytics.captureFeature(MARKETING_FEATURES.DOWNLOAD_MAC, MARKETING_SCREENS.HOME), "sent");
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    api_key: "phc_public_project_token",
    distinct_id: "stable_analytics_identifier_123",
    event: MARKETING_ANALYTICS_EVENTS.FEATURE_USED,
    properties: {
      surface: "web",
      route_kind: "marketing",
      $process_person_profile: false,
      $geoip_disable: true,
      action: "clicked",
      feature: MARKETING_FEATURES.DOWNLOAD_MAC,
      screen: MARKETING_SCREENS.HOME,
    },
  });
  const serialized = JSON.stringify(payloads[0]);
  assert.doesNotMatch(serialized, /url|query|hash|referrer|prompt|path|branch|message|stack/i);
});

test("deduplicates bursts and enforces a per-feature daily cap", () => {
  const harness = createHarness();
  assert.equal(harness.analytics.captureFeature(MARKETING_FEATURES.VIEW_DOCS), "sent");
  assert.equal(harness.analytics.captureFeature(MARKETING_FEATURES.VIEW_DOCS), "dropped");
  harness.advance(2_000);
  assert.equal(harness.analytics.captureFeature(MARKETING_FEATURES.VIEW_DOCS), "sent");
  harness.advance(2_000);
  assert.equal(harness.analytics.captureFeature(MARKETING_FEATURES.VIEW_DOCS), "sent");
  harness.advance(2_000);
  assert.equal(harness.analytics.captureFeature(MARKETING_FEATURES.VIEW_DOCS), "dropped");
  assert.equal(harness.payloads.length, 3);
});

test("emits one prior-day budget rollup before the next day's event", () => {
  const harness = createHarness();
  harness.analytics.captureAppOpened();
  harness.analytics.captureAppOpened();
  harness.advance(86_400_000);
  harness.analytics.captureScreen(MARKETING_SCREENS.HOME);

  assert.deepEqual(harness.payloads.map((payload) => payload.event), [
    MARKETING_ANALYTICS_EVENTS.APP_OPENED,
    MARKETING_ANALYTICS_EVENTS.ANALYTICS_BUDGET,
    MARKETING_ANALYTICS_EVENTS.SCREEN_VIEWED,
  ]);
  assert.equal(harness.payloads[1]?.properties.sent_count, 1);
  assert.equal(harness.payloads[1]?.properties.dropped_count, 1);
  assert.equal(harness.payloads[1]?.properties.drop_reason, "duplicate");
});

test("disabled analytics sends nothing and reset rotates identity without resetting quota", () => {
  const harness = createHarness({ enabled: false });
  assert.equal(harness.analytics.captureScreen(MARKETING_SCREENS.PRIVACY), "disabled");
  assert.equal(harness.payloads.length, 0);
  harness.setEnabled(true);
  harness.analytics.captureScreen(MARKETING_SCREENS.PRIVACY);
  assert.equal(harness.storage.values.size, 2);
  harness.analytics.reset();
  assert.equal(harness.storage.values.size, 1);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    harness.advance(2_000);
    harness.analytics.captureFeature(MARKETING_FEATURES.VIEW_DOCS);
    harness.analytics.reset();
  }
  assert.equal(harness.payloads.filter((payload) => payload.event === MARKETING_ANALYTICS_EVENTS.FEATURE_USED).length, 3);
});

test("blocked browser storage fails closed instead of resetting quota on reload", () => {
  const payloads: PostHogCapturePayload[] = [];
  let now = new Date("2026-07-13T12:00:00.000Z");
  const analytics = new MarketingAnalytics({
    projectToken: "phc_public_project_token",
    storage: new BlockedStorage(),
    isEnabled: () => true,
    now: () => now,
    idFactory: () => "stable_analytics_identifier_123",
    transport: (payload) => {
      payloads.push(payload);
    },
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    analytics.captureFeature(MARKETING_FEATURES.VIEW_DOCS);
    now = new Date(now.getTime() + 2_000);
  }

  assert.equal(payloads.length, 0);
});
