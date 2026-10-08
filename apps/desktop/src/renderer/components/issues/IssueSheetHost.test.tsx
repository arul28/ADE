/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../state/appStore";
import { openIssueInSheet } from "../../lib/issueNavigation";
import { IssueSheetHost } from "./IssueSheetHost";

// A Linear issue deeplink from outside ADE opens the issue sheet. These were
// TopBar tests while a deeplink opened the Linear pane and searched for the
// identifier; the sheet owns the same outcomes now.

const connected = {
  tokenStored: true,
  connected: true,
  viewerId: "user-1",
  viewerName: "Arul",
  checkedAt: "2026-04-22T01:00:00.000Z",
  authMode: "manual",
  oauthAvailable: true,
  tokenExpiresAt: null,
  message: null,
};

function linearIssue(identifier: string, title: string) {
  return {
    id: `id-${identifier}`,
    identifier,
    title,
    description: "Open the Linear issue from ADE links.",
    url: `https://linear.app/ade/issue/${identifier}`,
    projectId: "project-1",
    projectSlug: "desktop",
    projectName: "Desktop",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: [],
    metadataTags: [],
    assigneeId: null,
    assigneeName: null,
    creatorId: null,
    creatorName: null,
    blockerIssueIds: [],
    hasOpenBlockers: false,
    dueDate: null,
    estimate: null,
    archivedAt: null,
    completedAt: null,
    canceledAt: null,
    startedAt: null,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T01:00:00.000Z",
    raw: {},
  };
}

function openDeeplink(identifier: string) {
  act(() => {
    openIssueInSheet({ ref: { provider: "linear", identifier }, source: "deeplink" });
  });
}

describe("IssueSheetHost", () => {
  beforeEach(() => {
    window.location.hash = "#/lanes";
    useAppStore.setState({
      project: { rootPath: `/tmp/project-${Math.random()}`, displayName: "ADE" },
      projectBinding: null,
      showWelcome: false,
      lanes: [],
    } as any);
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("shows the issue itself for a Linear deeplink, read by identifier with no search", async () => {
    const searchLinearIssues = vi.fn();
    const getLinearIssue = vi.fn(async () => linearIssue("ADE-124", "Route issue deeplinks to the viewer"));
    (window as any).ade = {
      cto: {
        getLinearIssue,
        searchLinearIssues,
        getLinearConnectionStatus: vi.fn(async () => connected),
        getLinearIssueComments: vi.fn(async () => []),
        getLinearIssuePickerData: vi.fn(async () => ({ projects: [], users: [], states: [], labels: [] })),
      },
    };

    render(<IssueSheetHost />);
    openDeeplink("ADE-124");

    expect((await screen.findAllByText("Route issue deeplinks to the viewer")).length).toBeGreaterThan(0);
    expect(getLinearIssue).toHaveBeenCalledWith(expect.objectContaining({ issueId: "ADE-124" }));
    expect(searchLinearIssues).not.toHaveBeenCalled();
  });

  it("shows a setup state when Linear is not connected", async () => {
    (window as any).ade = {
      cto: {
        getLinearIssue: vi.fn(async () => {
          throw new Error("Linear is not connected.");
        }),
        getLinearConnectionStatus: vi.fn(async () => ({ ...connected, tokenStored: false, connected: false, message: "Connect Linear first." })),
      },
    };

    render(<IssueSheetHost />);
    openDeeplink("ADE-125");

    expect(await screen.findByText("Connect Linear to open ADE-125")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open linear settings/i }));
    expect(window.location.hash).toBe("#/settings?tab=integrations#linear-connection");
  });

  it("offers the project picker when no ADE project is open", async () => {
    useAppStore.setState({ project: null, projectBinding: null } as any);
    (window as any).ade = {
      cto: {
        getLinearIssue: vi.fn(async () => {
          throw new Error("No project is open.");
        }),
      },
    };

    render(<IssueSheetHost />);
    openDeeplink("ADE-126");

    expect(await screen.findByText("Open the ADE project for ADE-126")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open project picker/i }));
    expect(useAppStore.getState().showWelcome).toBe(true);
  });
});
