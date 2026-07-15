import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAdeLoopbackListener,
  isLoopbackShadowedError,
  probeAdeLoopbackListener,
  SYNC_LOOPBACK_ADE_MARKER_HEADER,
  SYNC_LOOPBACK_ADE_MARKER_VALUE,
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

describe("probeAdeLoopbackListener ADE marker enforcement", () => {
  it("accepts a 426 loopback listener that presents the ADE marker header", async () => {
    // The production marker-emitting handler is the source of truth.
    const port = await startServer(writeAdeLoopbackUpgradeResponse);
    const result = await probeAdeLoopbackListener(port);
    expect(result).toMatchObject({
      ok: true,
      statusCode: 426,
      reason: null,
    });
    await expect(assertAdeLoopbackListener(port)).resolves.toMatchObject({ ok: true });
  });

  it("rejects a bare 426 listener that omits the ADE marker (foreign/stale ws)", async () => {
    const port = await startServer((_request, response) => {
      const body = "Upgrade Required";
      response.writeHead(426, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
    });
    const result = await probeAdeLoopbackListener(port);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(426);
    expect(result.reason).toMatch(/did not present the ADE loopback marker/);
    expect(result.reason).toContain(SYNC_LOOPBACK_ADE_MARKER_HEADER);
    await expect(assertAdeLoopbackListener(port)).rejects.toSatisfy(isLoopbackShadowedError);
  });

  it("rejects a 426 listener that sends a mismatched marker value", async () => {
    const port = await startServer((_request, response) => {
      const body = "Upgrade Required";
      response.writeHead(426, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
        [SYNC_LOOPBACK_ADE_MARKER_HEADER]: "totally-not-ade",
      });
      response.end(body);
    });
    const result = await probeAdeLoopbackListener(port);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not present the ADE loopback marker/);
  });

  it("rejects a non-426 foreign listener (marker present but wrong status)", async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(404, "Not Found", {
        [SYNC_LOOPBACK_ADE_MARKER_HEADER]: SYNC_LOOPBACK_ADE_MARKER_VALUE,
      });
      response.end("nope");
    });
    const result = await probeAdeLoopbackListener(port);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.reason).toMatch(/Expected ADE 426 Upgrade Required/);
  });
});
