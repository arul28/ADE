import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAdeLoopbackListener,
  generateLoopbackNonce,
  isLoopbackShadowedError,
  probeAdeLoopbackListener,
  SYNC_LOOPBACK_ADE_MARKER_HEADER,
  writeAdeLoopbackUpgradeResponse,
} from "./syncLoopbackProbe";

type RequestHandler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => void;

const servers: http.Server[] = [];

async function startServer(handler: RequestHandler): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Failed to resolve loopback probe test server port.");
  }
  return address.port;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("probeAdeLoopbackListener per-instance identity enforcement", () => {
  it("accepts its own listener identity and rejects a different ADE listener instance", async () => {
    const nonceA = generateLoopbackNonce();
    const nonceB = generateLoopbackNonce();
    expect(nonceA).toMatch(/^[a-f0-9]{32}$/);
    expect(nonceB).not.toBe(nonceA);
    const portA = await startServer((request, response) => {
      writeAdeLoopbackUpgradeResponse(request, response, nonceA);
    });
    const portB = await startServer((request, response) => {
      writeAdeLoopbackUpgradeResponse(request, response, nonceB);
    });

    const ownResult = await probeAdeLoopbackListener(portA, nonceA);
    expect(ownResult).toMatchObject({
      ok: true,
      statusCode: 426,
      markerValue: nonceA,
      reason: null,
    });
    await expect(assertAdeLoopbackListener(portA, nonceA)).resolves.toMatchObject({ ok: true });

    const otherInstanceResult = await probeAdeLoopbackListener(portB, nonceA);
    expect(otherInstanceResult).toMatchObject({
      ok: false,
      statusCode: 426,
      markerValue: nonceB,
    });
    expect(otherInstanceResult.reason).toMatch(/different loopback identity/);
    await expect(assertAdeLoopbackListener(portB, nonceA))
      .rejects.toSatisfy(isLoopbackShadowedError);
  });

  it("rejects a bare 426 listener that omits the loopback identity", async () => {
    const expectedNonce = generateLoopbackNonce();
    const port = await startServer((_request, response) => {
      const body = "Upgrade Required";
      response.writeHead(426, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
    });
    const result = await probeAdeLoopbackListener(port, expectedNonce);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(426);
    expect(result.markerValue).toBeNull();
    expect(result.reason).toMatch(/did not present a loopback identity/);
    expect(result.reason).toContain(SYNC_LOOPBACK_ADE_MARKER_HEADER);
    await expect(assertAdeLoopbackListener(port, expectedNonce))
      .rejects.toSatisfy(isLoopbackShadowedError);
  });

  it("rejects the forgeable legacy static marker value", async () => {
    const expectedNonce = generateLoopbackNonce();
    const port = await startServer((_request, response) => {
      const body = "Upgrade Required";
      response.writeHead(426, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
        [SYNC_LOOPBACK_ADE_MARKER_HEADER]: "1",
      });
      response.end(body);
    });
    const result = await probeAdeLoopbackListener(port, expectedNonce);
    expect(result).toMatchObject({ ok: false, statusCode: 426, markerValue: "1" });
    expect(result.reason).toMatch(/different loopback identity/);
    await expect(assertAdeLoopbackListener(port, expectedNonce))
      .rejects.toSatisfy(isLoopbackShadowedError);
  });

  it("rejects a non-426 foreign listener (marker present but wrong status)", async () => {
    const expectedNonce = generateLoopbackNonce();
    const port = await startServer((_request, response) => {
      response.writeHead(404, "Not Found", {
        [SYNC_LOOPBACK_ADE_MARKER_HEADER]: expectedNonce,
      });
      response.end("nope");
    });
    const result = await probeAdeLoopbackListener(port, expectedNonce);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.markerValue).toBe(expectedNonce);
    expect(result.reason).toMatch(/Expected ADE 426 Upgrade Required/);
  });
});

/**
 * A probe that reads no answer says nothing about who owns the port, so the
 * assertion re-probes it once. These use the real probe with a short deadline
 * (the healthy answer costs milliseconds) so a "slow" peer is a bounded wait
 * rather than a wall-clock sleep.
 */
describe("assertAdeLoopbackListener shadow verdicts", () => {
  const PROBE_DEADLINE_MS = 150;
  const SLOW_ANSWER_MS = 400;
  const shortProbe = (port: number, expectedNonce: string) =>
    probeAdeLoopbackListener(port, expectedNonce, PROBE_DEADLINE_MS);

  it("accepts a healthy ADE listener on its first answer", async () => {
    const expectedNonce = generateLoopbackNonce();
    let requests = 0;
    const port = await startServer((request, response) => {
      requests += 1;
      writeAdeLoopbackUpgradeResponse(request, response, expectedNonce);
    });
    await expect(assertAdeLoopbackListener(port, expectedNonce, shortProbe))
      .resolves.toMatchObject({ ok: true, statusCode: 426, markerValue: expectedNonce });
    // The retry exists for silence, so the working path still costs one probe.
    expect(requests).toBe(1);
  });

  it("rejects a foreign listener on its answer, without re-probing it", async () => {
    const expectedNonce = generateLoopbackNonce();
    let requests = 0;
    const port = await startServer((_request, response) => {
      requests += 1;
      const body = "Upgrade Required";
      response.writeHead(426, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
      response.end(body);
    });
    // A peer that answered has answered: the retry is for silence only, so this
    // costs one request, not two.
    await expect(assertAdeLoopbackListener(port, expectedNonce, shortProbe))
      .rejects.toSatisfy(isLoopbackShadowedError);
    expect(requests).toBe(1);
  });

  it("accepts a port whose listener answered past the probe deadline", async () => {
    const expectedNonce = generateLoopbackNonce();
    let requests = 0;
    const port = await startServer((request, response) => {
      requests += 1;
      response.on("error", () => {});
      const reply = () => {
        if (response.destroyed || response.writableEnded) return;
        writeAdeLoopbackUpgradeResponse(request, response, expectedNonce);
      };
      // Busy for the first probe — the answer lands after the deadline and is
      // never read — and free by the time the assertion re-probes. This is the
      // false shadow: the port is ADE's own, and only the first read was late.
      if (requests === 1) setTimeout(reply, SLOW_ANSWER_MS);
      else reply();
    });
    await expect(assertAdeLoopbackListener(port, expectedNonce, shortProbe))
      .resolves.toMatchObject({ ok: true, statusCode: 426, markerValue: expectedNonce });
  });

  it("still rejects a peer that never answers", async () => {
    const expectedNonce = generateLoopbackNonce();
    // Accepts the connection and never writes a response: a wedged or suspended
    // owner of 127.0.0.1:<port>, which must not be advertised.
    const port = await startServer(() => {});
    const failure = await assertAdeLoopbackListener(port, expectedNonce, shortProbe)
      .then(() => null, (error: unknown) => error);
    expect(isLoopbackShadowedError(failure)).toBe(true);
    expect((failure as Error).message).toMatch(
      new RegExp(`Loopback ADE probe timed out after ${PROBE_DEADLINE_MS}ms`),
    );
  });
});
