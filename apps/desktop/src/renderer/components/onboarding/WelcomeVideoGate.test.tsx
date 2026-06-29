/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeVideoGate } from "./WelcomeVideoGate";
import {
  ADE_WELCOME_VIDEO_ID,
  ADE_WELCOME_VIDEO_REPLAY_EVENT,
  ADE_WELCOME_VIDEO_VERSION,
} from "../../../shared/welcomeVideo";
import { ADE_MOBILE_TESTFLIGHT_URL } from "../../../shared/productLinks";

describe("WelcomeVideoGate", () => {
  const originalAde = window.ade;
  const getWelcomeVideoState = vi.fn();
  const markWelcomeVideoSeen = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    getWelcomeVideoState.mockReset();
    markWelcomeVideoSeen.mockReset();
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
    markWelcomeVideoSeen.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: "2026-06-28T12:00:00.000Z",
      dismissedAt: null,
    });
    window.ade = ({
      app: {
        ...((originalAde as typeof window.ade | undefined)?.app ?? {}),
        getWelcomeVideoState,
        markWelcomeVideoSeen,
        openExternal,
      },
    } as unknown) as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    window.ade = originalAde;
  });

  it("opens for an unseen video and marks it completed from Continue", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    expect(await screen.findByRole("dialog", { name: /welcome to ade/i })).toBeTruthy();
    expect(screen.queryByText(/start here/i)).toBeNull();
    expect(screen.queryByText(/quick orientation/i)).toBeNull();
    const video = screen.getByTitle("Welcome to ADE video");
    expect(video).toBeTruthy();
    expect(video.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-presentation allow-popups",
    );
    expect(video.getAttribute("allow")).toBe("autoplay; encrypted-media; picture-in-picture");

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(markWelcomeVideoSeen).toHaveBeenCalledWith("completed");
    });
    expect(screen.queryByRole("dialog", { name: /welcome to ade/i })).toBeNull();
  });

  it("stays hidden after a seen video until the replay event opens it", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: "2026-06-28T12:00:00.000Z",
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    await waitFor(() => {
      expect(getWelcomeVideoState).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog", { name: /welcome to ade/i })).toBeNull();

    window.dispatchEvent(new Event(ADE_WELCOME_VIDEO_REPLAY_EVENT));

    expect(await screen.findByRole("dialog", { name: /welcome to ade/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close welcome video/i }));

    await waitFor(() => {
      expect(markWelcomeVideoSeen).toHaveBeenCalledWith("dismissed");
    });
    expect(screen.queryByRole("dialog", { name: /welcome to ade/i })).toBeNull();
  });

  it("opens the mobile install link from the welcome actions", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    fireEvent.click(await screen.findByRole("button", { name: /install mobile app/i }));

    expect(openExternal).toHaveBeenCalledWith(ADE_MOBILE_TESTFLIGHT_URL);
  });
});
