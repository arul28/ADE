/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/pair#legacy-pairing-payload"}

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BrowserAccountClient, BrowserAccountSnapshot } from "../../account/client";
import type { AdeSyncClient, AdeSyncClientStatus } from "../../sync";
import { WebClientRoot } from "../WebClientRoot";

afterEach(cleanup);

const signedOutAccount: BrowserAccountSnapshot = {
  state: "signed_out",
  userId: null,
  email: null,
  name: null,
  machines: [],
  relayBaseUrls: ["wss://relay.example"],
  message: null,
};

const idleStatus: AdeSyncClientStatus = {
  state: "idle",
  endpoint: null,
  envId: null,
  hostDeviceId: null,
  hostName: null,
  connectedAt: null,
  lastSeenAt: null,
  error: null,
  activeProjectId: null,
  selectedEnvId: null,
};

describe("WebClientRoot entry routes", () => {
  it("retires /pair by scrubbing its payload and showing account sign-in", async () => {
    const client = {
      getStatus: () => idleStatus,
      listEnvironments: vi.fn(async () => []),
      pruneAccountOwnedEnvironments: vi.fn(async () => []),
      subscribe: vi.fn(() => () => undefined),
      onProjectCatalog: vi.fn(() => () => undefined),
    } as unknown as AdeSyncClient;
    const accountClient = {
      getSnapshot: () => signedOutAccount,
      bootstrap: vi.fn(async () => signedOutAccount),
    } as unknown as BrowserAccountClient;

    render(<WebClientRoot client={client} accountClient={accountClient} />);

    expect(await screen.findByRole("heading", { name: "Sign in to ADE" })).toBeTruthy();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
      expect(window.location.hash).toBe("");
    });
    expect(screen.queryByText(/pairing code/i)).toBeNull();
    expect(screen.queryByText(/pairing link/i)).toBeNull();
  });
});
