import { describe, expect, it } from "vitest";
import { admitEvent } from "../src/sentryScrub";

/**
 * The Worker's hourly Sentry budget, and what it does with Cloudflare's own
 * storage failures. The four Workers carry the same file
 * (`scripts/check-worker-sentry-scrub.mjs`), so this covers all of them.
 */
describe("admitEvent", () => {
  const exception = (value: string, type = "Error") => ({ exception: { values: [{ type, value }] } });
  // Each test runs in its own hour, so the module's window starts fresh.
  let hour = 0;
  const nextHour = () => (hour += 2) * 60 * 60 * 1000;

  it("groups Cloudflare storage failures into one issue per kind, whatever their reference", () => {
    const now = nextHour();
    const d1 = [
      exception("D1_ERROR: internal error; reference = 0f3a9c"),
      exception("D1_ERROR: internal error; reference = 77b21e"),
    ];
    const durable = exception("Internal error in Durable Object storage caused object to be reset.");
    expect(d1.map((event) => admitEvent(event, now))).toEqual([true, true]);
    expect(admitEvent(durable, now)).toBe(true);
    expect(d1.map((event) => (event as { fingerprint?: string[] }).fingerprint)).toEqual([
      ["cloudflare", "d1-internal-error"],
      ["cloudflare", "d1-internal-error"],
    ]);
    expect((durable as { fingerprint?: string[] }).fingerprint).toEqual(["cloudflare", "durable-object-storage"]);
    // Grouped, they share one budget: the sixth copy in an hour is dropped.
    const more = Array.from({ length: 4 }, (_, index) => admitEvent(exception(`D1_ERROR: internal error; reference = r${index}`), now));
    expect(more).toEqual([true, true, true, false]);
  });

  // Every kind seen in production (ADE-WORKERS-G, H, J, K, M, N, P, Q, R) is one issue, whatever its reference.
  it.each([
    ["D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = 1tmblod67", "d1-storage-reset"],
    ["D1_ERROR: D1 DB is overloaded. Requests queued for too long.", "d1-overloaded"],
    ["D1_ERROR: Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.", "d1-connection-closed"],
    ["Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.", "durable-object-inactive"],
    ["Internal error while starting up Durable Object storage caused object to be reset; reference = k31gp", "durable-object-storage"],
    ["Durable Object storage is no longer accessible.", "durable-object-storage"],
    ["internal error; reference = bnpch2gr1hv7r31ifl4tvhvh", "cloudflare-internal-error"],
  ])("groups %s", (message, kind) => {
    const event = exception(message);
    admitEvent(event, nextHour());
    expect((event as { fingerprint?: string[] }).fingerprint).toEqual(["cloudflare", kind]);
  });

  it("drops a Durable Object reset caused by a deploy, and keeps other failures", () => {
    const now = nextHour();
    expect(admitEvent(exception("Durable Object reset because its code was updated."), now)).toBe(false);
    expect(admitEvent({ message: "Durable Object reset because its code was updated." }, now)).toBe(false);
    const other = exception("Cannot read properties of undefined (reading 'machineKey')", "TypeError");
    expect(admitEvent(other, now)).toBe(true);
    expect((other as { fingerprint?: string[] }).fingerprint).toBeUndefined();
  });

  it("keeps a fingerprint the Worker already set", () => {
    const event = { ...exception("D1_ERROR: internal error; reference = 1"), fingerprint: ["push", "send"] };
    expect(admitEvent(event, nextHour())).toBe(true);
    expect(event.fingerprint).toEqual(["push", "send"]);
  });
});
