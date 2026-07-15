import { once } from "node:events";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeRpcTransport } from "../../../../desktop/src/main/services/remoteRuntime/runtimeRpcClient";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import { startSyncRemoteBridge } from "../remoteBridge";

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
    const write = vi.fn((chunk: string) => {
      expect(chunk).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      onData?.(Buffer.from('{"jsonrpc":"2.0","id":1,"result":"pong"}\n', "utf8"));
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
      socket.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      const [response] = await once(socket, "data") as [Buffer];
      expect(response.toString("utf8")).toBe('{"jsonrpc":"2.0","id":1,"result":"pong"}\n');
      expect(write).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
      await bridge.close();
    }
    expect(closeTransport).toHaveBeenCalled();
  });
});
