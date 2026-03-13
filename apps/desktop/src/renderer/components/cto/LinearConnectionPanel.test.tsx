// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LinearConnectionPanel } from "./LinearConnectionPanel";

function buildBridge() {
  return {
    app: {
      openExternal: vi.fn(async () => undefined),
    },
    cto: {
      getLinearConnectionStatus: vi
        .fn()
        .mockResolvedValueOnce({
          tokenStored: true,
          connected: false,
          viewerId: null,
          viewerName: null,
          checkedAt: "2026-03-05T00:00:00.000Z",
          message: "Linear connection lost.",
          authMode: "manual",
          oauthAvailable: true,
          tokenExpiresAt: null,
        })
        .mockResolvedValue({
          tokenStored: true,
          connected: true,
          viewerId: "viewer-oauth",
          viewerName: "Taylor",
          checkedAt: "2026-03-05T00:00:00.000Z",
          message: null,
          authMode: "oauth",
          oauthAvailable: true,
          tokenExpiresAt: "2026-03-06T00:00:00.000Z",
        }),
      getLinearProjects: vi.fn(async () => [
        { id: "project-1", name: "My Project", slug: "my-project", teamName: "Platform" },
      ]),
      startLinearOAuth: vi.fn(async () => ({
        sessionId: "oauth-session-1",
        authUrl: "https://linear.app/oauth/authorize?state=test",
        redirectUri: "http://127.0.0.1:40123/oauth/callback",
      })),
      getLinearOAuthSession: vi.fn(async () => ({
        status: "completed",
        connection: {
          tokenStored: true,
          connected: true,
          viewerId: "viewer-oauth",
          viewerName: "Taylor",
          checkedAt: "2026-03-05T00:00:00.000Z",
          message: null,
          authMode: "oauth",
          oauthAvailable: true,
          tokenExpiresAt: "2026-03-06T00:00:00.000Z",
        },
      })),
      setLinearToken: vi.fn(async () => ({
        tokenStored: true,
        connected: true,
        viewerId: "viewer-1",
        viewerName: "Alex",
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: null,
        authMode: "manual",
        oauthAvailable: true,
        tokenExpiresAt: null,
      })),
      clearLinearToken: vi.fn(async () => ({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: "Disconnected.",
        authMode: null,
        oauthAvailable: true,
        tokenExpiresAt: null,
      })),
    },
  };
}

describe("LinearConnectionPanel", () => {
  beforeEach(() => {
    (window as any).ade = buildBridge();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows reconnect state when a stored token is degraded", async () => {
    render(<LinearConnectionPanel />);

    await waitFor(() => {
      expect(screen.getByText("Linear connection lost.")).toBeTruthy();
    });
    expect(screen.getByText("Degraded")).toBeTruthy();
  });

  it("validates a token and loads projects", async () => {
    render(<LinearConnectionPanel />);

    await waitFor(() => expect(screen.getByPlaceholderText("lin_api_...")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("lin_api_..."), { target: { value: "lin_api_test" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect((window as any).ade.cto.setLinearToken).toHaveBeenCalledWith({ token: "lin_api_test" });
      expect(screen.getByText(/Connected as/)).toBeTruthy();
      expect(screen.getByText("My Project")).toBeTruthy();
    });
  });

  it("starts OAuth and completes the loopback session", async () => {
    render(<LinearConnectionPanel />);

    await waitFor(() => expect(screen.getByRole("button", { name: /connect with linear/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /connect with linear/i }));

    await waitFor(() => {
      expect((window as any).ade.cto.startLinearOAuth).toHaveBeenCalledTimes(1);
      expect((window as any).ade.app.openExternal).toHaveBeenCalledWith("https://linear.app/oauth/authorize?state=test");
      expect(screen.getByText(/Connected as/)).toBeTruthy();
      expect(screen.getByText("My Project")).toBeTruthy();
    });
  });

  it("does not refetch status in a loop when onStatusChange triggers a parent rerender", async () => {
    const bridge = buildBridge();
    bridge.cto.getLinearConnectionStatus = vi.fn(async () => ({
      tokenStored: false,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: "2026-03-05T00:00:00.000Z",
      message: null,
      authMode: null,
      oauthAvailable: false,
      tokenExpiresAt: null,
    }));
    (window as any).ade = bridge;

    function Wrapper() {
      const [, setStatus] = React.useState<unknown>(null);
      return <LinearConnectionPanel onStatusChange={(status) => setStatus(status)} />;
    }

    render(<Wrapper />);

    await waitFor(() => {
      expect((window as any).ade.cto.getLinearConnectionStatus).toHaveBeenCalledTimes(1);
    });
  });
});
