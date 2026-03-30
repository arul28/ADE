/* @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearSection } from "./LinearSection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("LinearSection", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.window.ade = originalAde;
  });

  it("keeps the newer connected state when an earlier status load resolves late", async () => {
    const initialStatus = deferred<any>();
    const getLinearConnectionStatus = vi.fn().mockImplementationOnce(() => initialStatus.promise);
    const getLinearProjects = vi.fn().mockResolvedValue([
      { id: "project-1", name: "Core platform", teamName: "ADE" },
    ]);
    const setLinearToken = vi.fn().mockResolvedValue({
      connected: true,
      tokenStored: true,
      authMode: "token",
      viewerName: "Taylor",
      message: null,
      oauthAvailable: true,
      projectCount: 1,
    });

    globalThis.window.ade = {
      cto: {
        getLinearConnectionStatus,
        getLinearProjects,
        setLinearToken,
        startLinearOAuth: vi.fn(),
        getLinearOAuthSession: vi.fn(),
        clearLinearToken: vi.fn(),
      },
      app: {
        openExternal: vi.fn(),
      },
    } as any;

    render(<LinearSection />);

    fireEvent.change(screen.getByLabelText("Linear API key"), { target: { value: "lin_api_test" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(setLinearToken).toHaveBeenCalledWith({ token: "lin_api_test" });
    });
    expect(await screen.findByText("Connected to Linear")).toBeTruthy();
    expect(await screen.findByText("Core platform")).toBeTruthy();

    await act(async () => {
      initialStatus.resolve({
        connected: false,
        tokenStored: false,
        authMode: null,
        viewerName: null,
        message: null,
        oauthAvailable: true,
        projectCount: 0,
      });
      await initialStatus.promise;
    });

    expect(screen.getByText("Connected to Linear")).toBeTruthy();
    expect(screen.getByText("Core platform")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("does not start OAuth when the browser bridge is unavailable", async () => {
    const startLinearOAuth = vi.fn();

    globalThis.window.ade = {
      cto: {
        getLinearConnectionStatus: vi.fn().mockResolvedValue({
          connected: false,
          tokenStored: false,
          authMode: null,
          viewerName: null,
          message: null,
          oauthAvailable: true,
          projectCount: 0,
        }),
        getLinearProjects: vi.fn(),
        setLinearToken: vi.fn(),
        startLinearOAuth,
        getLinearOAuthSession: vi.fn(),
        clearLinearToken: vi.fn(),
      },
      app: {},
    } as any;

    render(<LinearSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Linear" }));

    await waitFor(() => {
      expect(startLinearOAuth).not.toHaveBeenCalled();
      expect(screen.getByText("Browser sign-in is not available in this ADE build.")).toBeTruthy();
    });
  });
});
