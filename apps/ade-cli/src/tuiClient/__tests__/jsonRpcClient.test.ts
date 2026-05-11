import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonRpcClient } from "../jsonRpcClient";

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("JsonRpcClient", () => {
  it("handles framed notifications before JSONL responses", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => {
      resolveServerSocket(socket);
      socket.on("data", (chunk) => {
        const text = String(chunk);
        const match = /"id":(\d+)/.exec(text);
        const id = match ? Number.parseInt(match[1]!, 10) : 1;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n`);
      });
    });

    await listen(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const notification = new Promise((resolve) => {
        client.onNotification("chat/event", resolve);
      });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        method: "chat/event",
        params: { sessionId: "s1" },
      });
      socket.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);

      await expect(notification).resolves.toEqual({ sessionId: "s1" });
      await expect(client.request("ping")).resolves.toEqual({ ok: true });
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors byte-based Content-Length framing for unicode payloads", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-jsonrpc-"));
    const socketPath = path.join(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => {
      resolveServerSocket(socket);
    });

    await listen(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const notification = new Promise((resolve) => {
        client.onNotification("chat/event", resolve);
      });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        method: "chat/event",
        params: { message: "héllo ✅" },
      });
      const framed = Buffer.concat([
        Buffer.from(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`, "ascii"),
        Buffer.from(payload, "utf8"),
      ]);
      socket.write(framed.subarray(0, 20));
      socket.write(framed.subarray(20));

      await expect(notification).resolves.toEqual({ message: "héllo ✅" });
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
