/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/pair"}

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { encodePairingQrUrl } from "../../../../shared/pairingQr";
import type { SyncPairingQrPayload } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";
import { PairFlow } from "../PairFlow";

afterEach(cleanup);

const payload: SyncPairingQrPayload = {
  version: 3,
  hostIdentity: {
    deviceId: "host-1",
    siteId: "site-1",
    name: "Studio Mac",
    platform: "macOS",
    deviceType: "desktop",
  },
  port: 8787,
  addressCandidates: [],
  relayUrl: "wss://relay.example/connect/host-1",
};

describe("PairFlow Relay guidance", () => {
  it("asks a signed-out user to sign in before showing the Relay pairing code", () => {
    const onSignIn = vi.fn();
    render(
      <PairFlow
        client={{} as AdeSyncClient}
        hash={new URL(encodePairingQrUrl(payload)).hash}
        relayAccess={{ kind: "signed_out" }}
        onSignIn={onSignIn}
        onPaired={vi.fn()}
      />,
    );

    expect(screen.getByText("Sign in with the same ADE account as this Mac, or connect directly.")).toBeTruthy();
    expect(screen.queryByLabelText("PIN digit 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.getByText("Connect directly (advanced)")).toBeTruthy();
  });
});
