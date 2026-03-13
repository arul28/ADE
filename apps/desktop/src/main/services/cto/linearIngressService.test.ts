import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createLinearIngressService } from "./linearIngressService";

describe("linearIngressService", () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("ensures the relay webhook and stores ingress status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-ingress-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        endpointId: "endpoint-1",
        webhookUrl: "https://relay.example.com/linear/webhooks/endpoint-1",
        signingSecret: "relay-secret",
        lastDeliveredAt: null,
      }),
    } as Response);
    fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("aborted");
    });

    vi.stubGlobal("fetch", fetchMock);

    const service = createLinearIngressService({
      db,
      projectId: "project-1",
      linearClient: {
        listWebhooks: vi.fn(async () => []),
        createWebhook: vi.fn(async () => ({ id: "webhook-1" })),
      } as any,
      secretService: {
        getSecret: (key: string) =>
          key === "linearRelay.apiBaseUrl"
            ? "https://relay.example.com"
            : key === "linearRelay.remoteProjectId"
              ? "remote-project-1"
              : key === "linearRelay.accessToken"
                ? "token-1"
                : null,
      } as any,
    });

    await service.ensureRelayWebhook(true);
    const status = service.getStatus();

    expect(status.localWebhook.status).toBe("listening");
    expect(status.localWebhook.url).toContain("/linear-webhooks");
    expect(status.relay.status).toBe("ready");
    expect(status.relay.webhookUrl).toContain("/linear/webhooks/endpoint-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    service.dispose();
    db.close();
  });

  it("does not auto-start ingress when relay credentials are missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-ingress-"));
    const db = await openKvDb(path.join(root, "ade.db"), { debug() {}, info() {}, warn() {}, error() {} } as any);

    vi.stubGlobal("fetch", fetchMock);

    const service = createLinearIngressService({
      db,
      projectId: "project-1",
      linearClient: {
        listWebhooks: vi.fn(async () => []),
        createWebhook: vi.fn(async () => ({ id: "webhook-1" })),
      } as any,
      secretService: {
        getSecret: () => null,
      } as any,
    });

    await service.start();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.getStatus().localWebhook.status).toBe("disabled");
    expect(service.canAutoStart()).toBe(false);

    service.dispose();
    db.close();
  });
});
