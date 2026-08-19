// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY } from "../../../shared/types";
import { subscribeOpenConnectionsPanel } from "../../lib/connectionsPanel";
import { PublishToGitHubDialog } from "./PublishToGitHubDialog";

const getStatus = vi.fn();
const publishCurrentProject = vi.fn();
const setToken = vi.fn();
const openExternal = vi.fn();

function status(overrides: Record<string, unknown> = {}) {
  return {
    connected: false,
    userLogin: null,
    credentialStoreUnreadable: false,
    ...overrides,
  };
}

beforeEach(() => {
  getStatus.mockReset();
  publishCurrentProject.mockReset();
  setToken.mockReset();
  openExternal.mockReset();
  getStatus.mockResolvedValue(status());
  (globalThis as any).window.ade = {
    github: { getStatus, setToken, publishCurrentProject },
    app: { openExternal },
  };
});

afterEach(() => {
  cleanup();
});

function renderDialog() {
  return render(
    <PublishToGitHubDialog
      open
      onOpenChange={() => {}}
      defaultRepoName="ade"
      onPublished={() => {}}
    />,
  );
}

/** Drives the dialog into the connect step the way the main process does. */
async function reachConnectStep() {
  publishCurrentProject.mockRejectedValue(
    new Error("github_not_connected: GitHub is not connected."),
  );
  await waitFor(() => expect(getStatus).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
}

describe("PublishToGitHubDialog", () => {
  // An unreadable store is NOT "not connected" — the saved sign-in may still be
  // on disk. Offering "Save token" here writes over a credential that repair can
  // still recover, so the only route out of this state is Settings → Connections.
  it("offers repair instead of token replacement when the credential store is unreadable", async () => {
    getStatus.mockResolvedValue(status({ credentialStoreUnreadable: true }));
    const openedTabs: string[] = [];
    const unsubscribe = subscribeOpenConnectionsPanel((tab) => openedTabs.push(tab));
    try {
      renderDialog();
      await reachConnectStep();

      const repair = await screen.findByRole("button", {
        name: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.action,
      });
      expect(screen.queryByRole("button", { name: /save token/i })).toBeNull();
      expect(screen.queryByLabelText(/personal access token/i)).toBeNull();

      fireEvent.click(repair);
      expect(openedTabs).toEqual(["machines"]);
      expect(setToken).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("still offers token entry when the store is readable and GitHub is simply not connected", async () => {
    renderDialog();
    await reachConnectStep();

    expect(await screen.findByRole("button", { name: /save token/i })).toBeTruthy();
    // Also proves the negative assertion in the unreadable case is not vacuous.
    expect(screen.getByLabelText(/personal access token/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.action }),
    ).toBeNull();
  });

  // The open-time status is stale by the time a publish fails; a store that went
  // unreadable in between would otherwise still be offered a replacement token.
  it("re-reads the store verdict before offering a fix", async () => {
    getStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ credentialStoreUnreadable: true }));
    renderDialog();
    await reachConnectStep();

    expect(
      await screen.findByRole("button", { name: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.action }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save token/i })).toBeNull();
  });
});
