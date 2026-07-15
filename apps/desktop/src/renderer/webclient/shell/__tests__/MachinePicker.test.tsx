/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BrowserAccountSnapshot } from "../../account/client";
import { MachinePicker } from "../MachinePicker";

afterEach(cleanup);

function account(overrides: Partial<BrowserAccountSnapshot> = {}): BrowserAccountSnapshot {
  return {
    state: "signed_out",
    userId: null,
    email: null,
    name: null,
    machines: [],
    relayBaseUrls: ["wss://relay.example"],
    message: null,
    ...overrides,
  };
}

function renderPicker(snapshot: BrowserAccountSnapshot) {
  const onSelectAccountMachine = vi.fn();
  const onSignIn = vi.fn();
  const onRetryDirectory = vi.fn();
  render(
    <MachinePicker
      environments={[]}
      account={snapshot}
      connectingMachineKey={null}
      onSelect={vi.fn()}
      onSelectAccountMachine={onSelectAccountMachine}
      onPair={vi.fn()}
      onSignIn={onSignIn}
      onSignOut={vi.fn()}
      onRetryDirectory={onRetryDirectory}
    />,
  );
  return { onSelectAccountMachine, onSignIn, onRetryDirectory };
}

describe("MachinePicker account states", () => {
  it("keeps pairing available while signed out", () => {
    const { onSignIn } = renderPicker(account());

    expect(screen.getByText("Optional — pairing works without an account")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair a new machine" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("lists reachable and offline account machines without making offline rows connectable", () => {
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
    const offline = {
      ...available,
      machineKey: "mk-offline",
      deviceId: "device-offline",
      name: "Offline Studio",
      online: false,
    };
    const { onSelectAccountMachine } = renderPicker(account({
      state: "signed_in",
      email: "owner@example.test",
      machines: [available, offline],
    }));

    const onlineButton = screen.getByRole("button", { name: /Online Studio.*available.*mk-online/i });
    const offlineButton = screen.getByRole("button", { name: /Offline Studio.*offline.*mk-offline/i });
    expect((onlineButton as HTMLButtonElement).disabled).toBe(false);
    expect((offlineButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Signed in as owner@example.test")).toBeTruthy();
    fireEvent.click(onlineButton);
    expect(onSelectAccountMachine).toHaveBeenCalledWith(available);
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
      email: "owner@example.test",
      message: "Couldn't reach the machine directory.",
    }));

    expect(screen.getByText("Signed in as owner@example.test")).toBeTruthy();
    expect(screen.getByText("Couldn't reach the machine directory.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryDirectory).toHaveBeenCalledOnce();
  });
});
