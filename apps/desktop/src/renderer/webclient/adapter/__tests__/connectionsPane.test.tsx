/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConnectionsPanel } from "../../../components/app/ConnectionsPanel";
import type { BrowserAccountClient, BrowserAccountSnapshot } from "../../account/client";
import type { AdeSyncClient } from "../../sync";
import { createAdeWebAdapter } from "../index";

afterEach(cleanup);

describe("hosted Connections pane", () => {
  it("renders the shared pane with concrete web adapter connection surfaces", async () => {
    const client = {
      getStatus: () => ({
        state: "connected",
        endpoint: "wss://relay.example/connect/machine-1",
        envId: "env-1",
        hostDeviceId: "host-1",
        hostName: "Studio Mac",
        connectedAt: "2026-07-17T00:00:00.000Z",
        lastSeenAt: "2026-07-17T00:00:00.000Z",
        error: null,
        activeProjectId: "project-1",
        selectedEnvId: "env-1",
      }),
      getProjectCatalog: vi.fn(async () => ({ projects: [] })),
      getCommandDescriptors: () => [],
      subscribe: vi.fn(() => () => undefined),
      onProjectCatalog: vi.fn(() => () => undefined),
      onBrainStatus: vi.fn(() => () => undefined),
      onTablesChanged: vi.fn(() => () => undefined),
      onChatEvent: vi.fn(() => () => undefined),
      subscribeChat: vi.fn(() => () => undefined),
      subscribeTerminal: vi.fn(() => () => undefined),
    } as unknown as AdeSyncClient;
    const accountSnapshot: BrowserAccountSnapshot = {
      state: "signed_in",
      userId: "user-1",
      email: "owner@example.test",
      name: "Owner",
      imageUrl: null,
      expiresAt: "2026-07-18T00:00:00.000Z",
      machines: [],
      relayBaseUrls: ["wss://relay.example"],
      message: null,
    };
    const accountClient = {
      getSnapshot: () => accountSnapshot,
      loadMachines: vi.fn(async () => accountSnapshot),
    } as unknown as BrowserAccountClient;
    const adapter = createAdeWebAdapter(client, [], accountClient);
    const previousAde = window.ade;
    window.ade = adapter.ade;
    let view: ReturnType<typeof render> | null = null;
    try {
      view = render(
        <MemoryRouter initialEntries={["/work"]}>
          <ConnectionsPanel onClose={vi.fn()} />
        </MemoryRouter>,
      );

      expect(await screen.findByText("No Macs yet. Choose Add machine to connect one.")).toBeTruthy();
      await expect(window.ade.remoteRuntime.getConnectionSnapshot()).resolves.toEqual({
        connections: [],
        connectedCount: 0,
        updatedAt: expect.any(Number),
      });
      await expect(window.ade.sync.listDevices()).resolves.toEqual([
        expect.objectContaining({ isLocal: true, deviceType: "browser", connectionState: "self" }),
      ]);
    } finally {
      view?.unmount();
      adapter.dispose();
      window.ade = previousAde;
    }
  });
});
