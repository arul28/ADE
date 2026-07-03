import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ProcessJsonRpcClient } from "../remoteBridge";

class FakeRemoteRpcChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kill = vi.fn();
}

describe("remoteBridge", () => {
  it("clears pending RPC timers when remote responses resolve or reject", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const child = new FakeRemoteRpcChild();
    const client = new ProcessJsonRpcClient(child as never);

    const resolved = client.request("ade/ping");
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`);
    await expect(resolved).resolves.toEqual({ ok: true });

    const rejected = client.request("ade/fail");
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "remote failed" },
    })}\n`);
    await expect(rejected).rejects.toThrow("remote failed");

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    client.close();
    clearTimeoutSpy.mockRestore();
  });
});
