import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcClient } from "./jsonRpcClient";

let nextTestPipeId = 0;

function localTestSocketPath(tmpDir: string, fileName: string): string {
  if (process.platform !== "win32") return path.join(tmpDir, fileName);
  const stem = fileName.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `\\\\.\\pipe\\ade-jsonrpc-${process.pid}-${nextTestPipeId++}-${stem}`;
}

function listenRpc(server: net.Server, socketPath: string): Promise<void> {
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

function requestIds(text: string): number[] {
  return [...text.matchAll(/"id":(\d+)/g)].map((match) => Number.parseInt(match[1]!, 10));
}

/** Answer one request with a Content-Length frame, written by `write`, and expect the client to read it whole. */
async function expectFramedResponse(
  message: string,
  write: (framed: Buffer, socket: net.Socket) => void,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-jsonrpc-"));
  const socketPath = localTestSocketPath(tmpDir, "rpc.sock");
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const id of requestIds(String(chunk))) {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, result: { message } });
        write(Buffer.concat([
          Buffer.from(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`, "ascii"),
          Buffer.from(payload, "utf8"),
        ]), socket);
      }
    });
  });
  await listenRpc(server, socketPath);
  const client = await JsonRpcClient.connect(socketPath);
  try {
    await expect(client.request("read")).resolves.toEqual({ message });
  } finally {
    client.close();
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("JsonRpcClient", () => {
  it("handles a Content-Length framed response before JSONL responses", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-jsonrpc-"));
    const socketPath = localTestSocketPath(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    let answered = 0;
    const server = net.createServer((socket) => {
      resolveServerSocket(socket);
      socket.on("data", (chunk) => {
        for (const id of requestIds(String(chunk))) {
          const payload = JSON.stringify({ jsonrpc: "2.0", id, result: { answer: answered } });
          socket.write(answered === 0
            ? `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`
            : `${payload}\n`);
          answered += 1;
        }
      });
    });

    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      await expect(client.request("first")).resolves.toEqual({ answer: 0 });
      await expect(client.request("second")).resolves.toEqual({ answer: 1 });
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors byte-based Content-Length framing for unicode payloads", async () => {
    const message = "héllo ✅";
    await expectFramedResponse(message, (framed, socket) => {
      socket.write(framed.subarray(0, 20));
      socket.write(framed.subarray(20));
    });
  });

  it("matches responses whose ids are echoed as strings", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-jsonrpc-"));
    const socketPath = localTestSocketPath(tmpDir, "rpc.sock");
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line) as { id: number; method: string };
          const response = `${JSON.stringify({
            jsonrpc: "2.0",
            id: String(request.id),
            result: { method: request.method },
          })}\n`;
          socket.write(response.slice(0, 13));
          socket.write(response.slice(13));
        }
      });
    });

    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    try {
      await expect(client.request("ping")).resolves.toEqual({ method: "ping" });
    } finally {
      client.close();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles large Content-Length frames split across many chunks", async () => {
    const message = "x".repeat(128 * 1024);
    await expectFramedResponse(message, (framed, socket) => {
      for (let offset = 0; offset < framed.length; offset += 1024) {
        socket.write(framed.subarray(offset, offset + 1024));
      }
    });
  });

  it("fires onClose when the socket drops unexpectedly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-jsonrpc-"));
    const socketPath = localTestSocketPath(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => resolveServerSocket(socket));
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      socket.destroy();
      await expect(closed).resolves.toBeUndefined();
    } finally {
      client.close();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not fire onClose on an intentional close()", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-jsonrpc-"));
    const socketPath = localTestSocketPath(tmpDir, "rpc.sock");
    const server = net.createServer(() => {});
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    try {
      const onClose = vi.fn();
      client.onClose(onClose);
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "fails only that request while the brain still answers", answersPing: true },
    { name: "closes the socket once the brain answers nothing", answersPing: false },
  ])("after a request times out, $name", async ({ answersPing }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-jsonrpc-"));
    const socketPath = localTestSocketPath(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    let resolvePingSeen: () => void = () => {};
    const pingSeen = new Promise<void>((resolve) => {
      resolvePingSeen = resolve;
    });
    const server = net.createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const request = JSON.parse(buffered.slice(0, newline)) as { id: number; method: string };
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          // "slow" is never answered; "ping" only by a brain that is still there.
          if (request.method === "ping") {
            resolvePingSeen();
            if (!answersPing) continue;
          } else if (request.method === "slow") {
            continue;
          }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`);
        }
      });
      resolveServerSocket(socket);
    });
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    try {
      const slow = client.request("slow", undefined, { timeoutMs: 25 });
      const slowFailed = expect(slow).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(25);
      await slowFailed;
      await pingSeen;
      if (answersPing) {
        await expect(client.request("echo")).resolves.toEqual({ ok: true });
        expect(closed).toBe(false);
      } else {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(closed).toBe(true);
        await expect(client.request("after-timeout")).rejects.toThrow(/closed/i);
      }
    } finally {
      vi.useRealTimers();
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails the connection on parse garbage instead of continuing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-jsonrpc-"));
    const socketPath = localTestSocketPath(tmpDir, "rpc.sock");
    let resolveServerSocket: (socket: net.Socket) => void = () => {};
    const serverSocketReady = new Promise<net.Socket>((resolve) => {
      resolveServerSocket = resolve;
    });
    const server = net.createServer((socket) => resolveServerSocket(socket));
    await listenRpc(server, socketPath);
    const client = await JsonRpcClient.connect(socketPath);
    const socket = await serverSocketReady;
    try {
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      const pending = client.request("ping", undefined, { timeoutMs: 1_000 });
      socket.write("this is not json\n");

      await expect(pending).rejects.toThrow(/Invalid JSON-RPC response|non-JSON output|closed/i);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      client.close();
      socket.destroy();
      await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

