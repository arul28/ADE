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
