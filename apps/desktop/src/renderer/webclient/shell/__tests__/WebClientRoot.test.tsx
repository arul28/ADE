/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/pair#legacy-pairing-payload"}

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BrowserAccountClient, BrowserAccountSnapshot } from "../../account/client";
import type {
  AdeSyncClient,
  AdeSyncClientStatus,
  WebClientEnvironmentPruneResult,
  WebClientEnvironmentRecord,
} from "../../sync";
import { WebClientRoot } from "../WebClientRoot";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const signedOutAccount: BrowserAccountSnapshot = {
  state: "signed_out",
  userId: null,
  email: null,
  name: null,
  imageUrl: null,
  expiresAt: null,
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
  readiness: "disconnected",
};

const accountMachine = {
  machineKey: "machine-key",
  deviceId: "directory-device",
  name: "Directory Studio",
  platform: "macOS",
  deviceType: "desktop",
  reachableEndpoints: [{ kind: "relay" as const, url: "wss://relay.example/connect/machine-key" }],
  lastSeenAt: Date.now(),
  online: true,
};

function signedInAccount(): BrowserAccountSnapshot {
  return {
    ...signedOutAccount,
    state: "signed_in",
    userId: "account-current",
    email: "owner@example.test",
    machines: [accountMachine],
  };
}

function savedEnvironment(overrides: Partial<WebClientEnvironmentRecord> = {}): WebClientEnvironmentRecord {
  return {
    envId: "saved-local",
    machineName: "Current saved Mac",
    hostDeviceId: "saved-device",
    accountOwnerUserId: null,
    relayUrl: null,
    machineKeyUrl: null,
    addressCandidates: [],
    explicitWssEndpoints: ["wss://saved.example.test/sync"],
    port: 8787,
    pairedDeviceId: "browser-device",
    secret: "secret",
    dpopKeys: {} as CryptoKeyPair,
    siteId: "site-id",
    localDeviceId: "browser-device",
    localDeviceName: "ADE Web",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pruneResult(
  environments: WebClientEnvironmentRecord[],
  removedIds: string[] = [],
): WebClientEnvironmentPruneResult {
  return { removedIds, environments };
}

function syncClient(overrides: Record<string, unknown> = {}): AdeSyncClient {
  return {
    getStatus: () => idleStatus,
    listEnvironments: vi.fn(async () => []),
    pruneAccountOwnedEnvironments: vi.fn(async () => pruneResult([])),
    subscribe: vi.fn(() => () => undefined),
    onProjectCatalog: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as AdeSyncClient;
}

function browserAccountClient(
  snapshot: BrowserAccountSnapshot,
  overrides: Record<string, unknown> = {},
): BrowserAccountClient {
  return {
    getSnapshot: () => snapshot,
    bootstrap: vi.fn(async () => snapshot),
    ...overrides,
  } as unknown as BrowserAccountClient;
}

describe("WebClientRoot entry routes", () => {
  it("retires /pair by scrubbing its payload and showing account sign-in", async () => {
    window.history.replaceState(null, "", "/pair#legacy-pairing-payload");
    const client = syncClient();
    const accountClient = browserAccountClient(signedOutAccount);

    render(<WebClientRoot client={client} accountClient={accountClient} />);

    expect(screen.getByRole("heading", { name: "Sign in to ADE" })).toBeTruthy();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
      expect(window.location.hash).toBe("");
    });
    expect(screen.queryByText(/pairing code/i)).toBeNull();
    expect(screen.queryByText(/pairing link/i)).toBeNull();
  });

  it("renders sign-in immediately while browser storage is still pending", async () => {
    window.history.replaceState(null, "", "/");
    const never = new Promise<WebClientEnvironmentPruneResult>(() => undefined);
    const prune = vi.fn(() => never);
    const client = syncClient({ pruneAccountOwnedEnvironments: prune });

    render(<WebClientRoot client={client} accountClient={browserAccountClient(signedOutAccount)} />);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    await waitFor(() => expect(prune).toHaveBeenCalledWith(null));
    expect(screen.getByText("Loading saved environments…")).toBeTruthy();
    expect(screen.queryByText("Starting ADE")).toBeNull();
  });

  it("keeps storage failures non-fatal and retries saved-environment loading", async () => {
    const prune = vi.fn()
      .mockRejectedValueOnce(new Error("IndexedDB blocked"))
      .mockResolvedValueOnce(pruneResult([]));
    const client = syncClient({ pruneAccountOwnedEnvironments: prune });

    render(<WebClientRoot client={client} accountClient={browserAccountClient(signedOutAccount)} />);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(await screen.findByText("Browser storage unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(prune).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Browser storage unavailable")).toBeNull());
  });

  it("shows callback progress, then directory rows without waiting for account pruning", async () => {
    window.history.replaceState(null, "", "/account/callback?code=test&state=test");
    let currentSnapshot = signedOutAccount;
    let resolveDirectory!: (snapshot: BrowserAccountSnapshot) => void;
    const directoryResponse = new Promise<BrowserAccountSnapshot>((resolve) => {
      resolveDirectory = resolve;
    });
    const bootstrap = vi.fn(() => {
      currentSnapshot = { ...signedInAccount(), machines: [] };
      return directoryResponse;
    });
    const never = new Promise<WebClientEnvironmentPruneResult>(() => undefined);
    const listEnvironments = vi.fn(async () => [savedEnvironment({
      envId: "foreign",
      machineName: "Previous account Mac",
      accountOwnerUserId: "account-previous",
    })]);
    const client = syncClient({
      listEnvironments,
      pruneAccountOwnedEnvironments: vi.fn(() => never),
    });

    render(<WebClientRoot
      client={client}
      accountClient={browserAccountClient(signedOutAccount, {
        bootstrap,
        getSnapshot: () => currentSnapshot,
      })}
    />);

    expect(screen.getByRole("heading", { name: "Signing in…" })).toBeTruthy();
    expect(await screen.findByText("Loading your Macs…")).toBeTruthy();
    currentSnapshot = signedInAccount();
    resolveDirectory(currentSnapshot);

    expect(await screen.findByRole("button", { name: /Directory Studio.*Connect/i })).toBeTruthy();
    expect(screen.getByText("Loading saved environments…")).toBeTruthy();
    expect(screen.queryByText("Previous account Mac")).toBeNull();
    expect(listEnvironments).not.toHaveBeenCalled();
  });

  it("publishes only the environments returned after privacy pruning", async () => {
    window.history.replaceState(null, "", "/account/callback?code=test&state=test");
    let resolvePrune!: (result: WebClientEnvironmentPruneResult) => void;
    const prune = vi.fn(() => new Promise<WebClientEnvironmentPruneResult>((resolve) => {
      resolvePrune = resolve;
    }));
    const client = syncClient({
      listEnvironments: vi.fn(async () => [savedEnvironment({
        envId: "foreign",
        machineName: "Previous account Mac",
        accountOwnerUserId: "account-previous",
      })]),
      pruneAccountOwnedEnvironments: prune,
    });

    render(<WebClientRoot client={client} accountClient={browserAccountClient(signedInAccount())} />);

    expect(await screen.findByRole("button", { name: /Directory Studio.*Connect/i })).toBeTruthy();
    expect(screen.queryByText("Previous account Mac")).toBeNull();
    expect(screen.queryByText("Current saved Mac")).toBeNull();

    resolvePrune(pruneResult([savedEnvironment()], ["foreign"]));

    expect(await screen.findByRole("button", { name: /Current saved Mac/i })).toBeTruthy();
    expect(screen.queryByText("Previous account Mac")).toBeNull();
    expect(client.listEnvironments).not.toHaveBeenCalled();
  });

  it("passes the post-pair refresh into afterConnect instead of listing twice", async () => {
    const environment = savedEnvironment({ envId: "paired" });
    const listEnvironments = vi.fn(async () => [environment]);
    const client = syncClient({
      listEnvironments,
      pairWithAccountMachine: vi.fn(async () => environment),
      getProjectCatalog: vi.fn(async () => ({ projects: [] })),
    });
    const accountClient = browserAccountClient(signedInAccount(), {
      getAccessToken: vi.fn(async () => "account-token"),
      captureSessionLease: vi.fn(() => ({ userId: "account-current", generation: 1 })),
      isSessionLeaseCurrent: vi.fn(() => true),
      getRelayBaseUrls: vi.fn(() => ["wss://relay.example"]),
    });

    render(<WebClientRoot client={client} accountClient={accountClient} />);
    const machine = await screen.findByRole("button", { name: /Directory Studio.*Connect/i });
    fireEvent.click(machine);

    expect(await screen.findByRole("heading", { name: "Open a project" })).toBeTruthy();
    expect(listEnvironments).toHaveBeenCalledTimes(1);
  });
});
