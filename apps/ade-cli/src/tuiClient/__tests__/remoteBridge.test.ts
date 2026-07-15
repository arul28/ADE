import { once } from "node:events";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeRpcTransport } from "../../../../desktop/src/main/services/remoteRuntime/runtimeRpcClient";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import { startSyncRemoteBridge } from "../remoteBridge";

function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    socket.setEncoding("utf8");
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffered.slice(0, newline + 1));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Bridge socket closed before a complete JSON-RPC frame arrived."));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

const target: RemoteRuntimeTarget = {
  id: "account-target",
  name: "Account Studio",
  hostname: "relay.example",
  transport: "paired",
  pairedMachine: { hostIdentity: "host-account-1", machineKey: "machine-account-1" },
  sshUser: null,
  port: null,
  sshKeyPath: null,
  routes: [],
  lastSeenArch: null,
  runtimeBinaryVersion: null,
  lastConnectedAt: null,
};

describe("startSyncRemoteBridge", () => {
  it("pipes ADE Code JSON-RPC through the paired transport without an SSH route", async () => {
    let onData: ((chunk: Buffer) => void) | null = null;
    const request = '{"jsonrpc":"2.0","id":1,"method":"p€ng"}\n';
    const response = '{"jsonrpc":"2.0","id":1,"result":"p€ng"}\n';
    let forwarded = "";
    let responded = false;
    const write = vi.fn((chunk: string) => {
      forwarded += chunk;
      if (!forwarded.includes("\n") || responded) return;
      responded = true;
      expect(forwarded).toBe(request);
      const encoded = Buffer.from(response, "utf8");
      const splitAt = encoded.indexOf(Buffer.from("€", "utf8")) + 1;
      onData?.(encoded.subarray(0, splitAt));
      onData?.(encoded.subarray(splitAt));
    });
    const closeTransport = vi.fn();
    const transport: RuntimeRpcTransport = {
      write,
      close: closeTransport,
      onData: (callback) => {
        onData = callback;
      },
    };
    const bridge = await startSyncRemoteBridge({
      target,
      openTransport: vi.fn(async () => transport),
    });
    const socket = bridge.socketUrl.startsWith("tcp://")
      ? net.connect(Number(new URL(bridge.socketUrl).port), "127.0.0.1")
      : net.connect(bridge.socketUrl);

    try {
      await once(socket, "connect");
      const encoded = Buffer.from(request, "utf8");
      const splitAt = encoded.indexOf(Buffer.from("€", "utf8")) + 1;
      const responseLine = readLine(socket);
      socket.write(encoded.subarray(0, splitAt));
      socket.write(encoded.subarray(splitAt));
      await expect(responseLine).resolves.toBe(response);
      expect(forwarded).toBe(request);
    } finally {
      socket.destroy();
      await bridge.close();
    }
    expect(closeTransport).toHaveBeenCalled();
  });
});
