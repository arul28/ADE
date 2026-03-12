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

    expect(status.relay.status).toBe("ready");
    expect(status.relay.webhookUrl).toContain("/linear/webhooks/endpoint-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    service.dispose();
    db.close();
  });
});
