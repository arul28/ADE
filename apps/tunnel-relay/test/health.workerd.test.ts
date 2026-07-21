import { env } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

describe("Worker health in workerd", () => {
  it("returns safe version metadata without creating or waking a Durable Object", async () => {
    expect(await listDurableObjectIds(env.TUNNEL)).toEqual([]);

    const response = await worker.fetch(new Request("https://relay.test/health"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "ade-tunnel-relay",
      protocolVersion: 2,
      workerVersion: {
        id: expect.any(String),
        tag: expect.any(String),
        timestamp: expect.any(String),
      },
    });
    expect(await listDurableObjectIds(env.TUNNEL)).toEqual([]);
  });
});
