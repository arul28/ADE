import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { probeLocalhostPort } from "./probeLocalhostPort";

const openServers: Server[] = [];

async function listenOnLoopback(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("unexpected server address"));
        return;
      }
      openServers.push(server);
      resolve({ server, port: address.port });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeAndForgetServer(server: Server): Promise<void> {
  await closeServer(server);
  const index = openServers.indexOf(server);
  if (index >= 0) {
    openServers.splice(index, 1);
  }
}

afterEach(async () => {
  while (openServers.length) {
    const server = openServers.pop()!;
    await closeServer(server);
  }
});

describe("probeLocalhostPort", () => {
  it("returns true when a TCP listener is bound to the loopback port", async () => {
    const { port } = await listenOnLoopback();
    await expect(probeLocalhostPort(port)).resolves.toBe(true);
  });

  it("returns false when nothing is listening on the port", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { server, port } = await listenOnLoopback();
      await closeAndForgetServer(server);
      if (!(await probeLocalhostPort(port, 250))) {
        return;
      }
    }

    throw new Error("expected at least one closed ephemeral loopback port to reject connections");
  });

  it("rejects invalid ports without crashing", async () => {
    await expect(probeLocalhostPort(0)).resolves.toBe(false);
    await expect(probeLocalhostPort(70_000)).resolves.toBe(false);
    await expect(probeLocalhostPort(Number.NaN)).resolves.toBe(false);
  });
});
