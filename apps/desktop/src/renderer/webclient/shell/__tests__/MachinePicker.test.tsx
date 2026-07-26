/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BrowserAccountSnapshot } from "../../account/client";
import type { WebClientEnvironmentRecord } from "../../sync";
import { MachinePicker } from "../MachinePicker";

afterEach(cleanup);

function account(overrides: Partial<BrowserAccountSnapshot> = {}): BrowserAccountSnapshot {
  return {
    state: "signed_out",
    userId: null,
    email: null,
    name: null,
    imageUrl: null,
    expiresAt: null,
    machines: [],
    relayBaseUrls: ["wss://relay.example"],
    message: null,
    ...overrides,
  };
}

function savedEnvironment(): WebClientEnvironmentRecord {
  return {
    envId: "saved-env",
    machineName: "Saved Studio",
    hostDeviceId: "saved-host",
    accountOwnerUserId: null,
    relayUrl: null,
    machineKeyUrl: null,
    addressCandidates: [],
    explicitWssEndpoints: ["wss://studio.example.test:8787"],
    port: 8787,
    pairedDeviceId: "browser-device",
    secret: "paired-secret",
    dpopKeys: {} as CryptoKeyPair,
    dpopPublicKeyX963: "public-key",
    siteId: "site-id",
    localDeviceId: "browser-device",
    localDeviceName: "ADE Web",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastConnectedAt: "2026-01-02T00:00:00.000Z",
    lastGoodEndpoint: "wss://studio.example.test:8787",
    activeProjectId: null,
  };
}

function renderPicker(
  snapshot: BrowserAccountSnapshot,
  environments: WebClientEnvironmentRecord[] = [],
) {
  const onSelect = vi.fn();
  const onSelectAccountMachine = vi.fn();
  const onSignIn = vi.fn();
  const onRetryDirectory = vi.fn();
  render(
    <MachinePicker
      environments={environments}
      account={snapshot}
      relayAccess={snapshot.userId ? {
        kind: "signed_in",
        userId: snapshot.userId,
        hostDeviceIds: snapshot.machines.flatMap((machine) => machine.deviceId ? [machine.deviceId] : []),
        getAccessToken: async () => "test-token",
      } : { kind: "signed_out" }}
      connectingMachineKey={null}
      onSelect={onSelect}
      onSelectAccountMachine={onSelectAccountMachine}
      onSignIn={onSignIn}
      onSignOut={vi.fn()}
      onRetryDirectory={onRetryDirectory}
    />,
  );
  return { onSelect, onSelectAccountMachine, onSignIn, onRetryDirectory };
}

describe("MachinePicker account states", () => {
  it("uses account sign-in for new connections without showing PIN or pairing-link entry points", () => {
    const { onSignIn } = renderPicker(account());

    expect(screen.getByText("Sign in to open your machines in the browser.")).toBeTruthy();
    expect(screen.queryByText(/pairing link/i)).toBeNull();
    expect(screen.queryByText(/pairing code/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("keeps an existing saved environment available while signed out", () => {
    const environment = savedEnvironment();
    const { onSelect } = renderPicker(account(), [environment]);

    expect(screen.getByText("Saved on this browser")).toBeTruthy();
    const savedButton = screen.getByRole("button", { name: /Saved Studio/i });
    fireEvent.click(savedButton);
    expect(onSelect).toHaveBeenCalledWith(environment);
    expect(screen.queryByText(/pairing link/i)).toBeNull();
  });

  it("keeps account-created device trust available over a direct route after sign-out", () => {
    const environment = {
      ...savedEnvironment(),
      accountOwnerUserId: "signed-out-account",
    };
    const { onSelect } = renderPicker(account(), [environment]);

    const savedButton = screen.getByRole("button", { name: /Saved Studio/i });
    fireEvent.click(savedButton);
    expect(onSelect).toHaveBeenCalledWith(environment);
  });

  it("treats directory presence as a hint when a secure route is still available", () => {
    const available = {
      machineKey: "mk-online",
      deviceId: "device-online",
      name: "Online Studio",
      platform: "macOS",
      deviceType: "desktop",
      reachableEndpoints: [{ kind: "relay" as const, url: "wss://relay.example/connect/mk-online" }],
      lastSeenAt: 1_700_000_000_000,
      online: true,
    };
    const stalePresence = {
      ...available,
      machineKey: "mk-stale",
      deviceId: "device-stale",
      name: "Stale Presence Studio",
      reachableEndpoints: [{ kind: "relay" as const, url: "wss://relay.example/connect/mk-stale" }],
      online: false,
    };
    const unreachable = {
      ...available,
      machineKey: "mk-unreachable",
      deviceId: "device-unreachable",
      name: "Unreachable Studio",
      reachableEndpoints: [],
      online: false,
    };
    const { onSelectAccountMachine } = renderPicker(account({
      state: "signed_in",
      userId: "user_3GYkSensitiveSubject",
      email: "owner@example.test",
      imageUrl: "https://img.clerk.com/avatar.png",
      machines: [available, stalePresence, unreachable],
    }));

    const onlineButton = screen.getByRole("button", { name: /Online Studio.*Connect/i });
    const staleButton = screen.getByRole("button", { name: /Stale Presence Studio.*Connect/i });
    const unreachableButton = screen.getByRole("button", { name: /Unreachable Studio.*Can't reach this Mac/i });
    expect(screen.queryByText("mk-online")).toBeNull();
    expect((onlineButton as HTMLButtonElement).disabled).toBe(false);
    expect((staleButton as HTMLButtonElement).disabled).toBe(false);
    expect((unreachableButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.getByText("Signed in as owner@example.test")).toBeTruthy();
    expect(screen.queryByText("user_3GYkSensitiveSubject")).toBeNull();
    expect(document.querySelector('img[src="https://img.clerk.com/avatar.png"]')).toBeTruthy();
    fireEvent.click(staleButton);
    expect(onSelectAccountMachine).toHaveBeenCalledWith(stalePresence);
  });

  it("offers reauthentication for an expired account session", () => {
    const { onSignIn } = renderPicker(account({
      state: "auth_expired",
      message: "Your ADE account session expired. Sign in again.",
    }));

    expect(screen.getByText(/session expired/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("keeps account identity visible while the directory is unavailable", () => {
    const { onRetryDirectory } = renderPicker(account({
      state: "directory_unavailable",
      userId: "user-1",
      email: "owner@example.test",
      message: "Couldn't reach the machine directory.",
    }));

    expect(screen.getByText("Signed in as owner@example.test")).toBeTruthy();
    expect(screen.getByText("We couldn't load your machines. Your saved connections still work.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryDirectory).toHaveBeenCalledOnce();
  });
});
