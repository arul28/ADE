/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeVideoGate } from "./WelcomeVideoGate";
import {
  ADE_WELCOME_VIDEO_REPLAY_EVENT,
  ADE_WELCOME_VIDEO_VERSION,
} from "../../../shared/welcomeVideo";

describe("WelcomeVideoGate", () => {
  const originalAde = window.ade;
  const getWelcomeVideoState = vi.fn();
  const markWelcomeVideoSeen = vi.fn();

  beforeEach(() => {
    getWelcomeVideoState.mockReset();
    markWelcomeVideoSeen.mockReset();
    markWelcomeVideoSeen.mockResolvedValue({
      videoId: "64E0pViEiB8",
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: "2026-06-28T12:00:00.000Z",
      dismissedAt: null,
    });
    window.ade = ({
      app: {
        ...((originalAde as typeof window.ade | undefined)?.app ?? {}),
        getWelcomeVideoState,
        markWelcomeVideoSeen,
      },
    } as unknown) as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    window.ade = originalAde;
  });

  it("opens for an unseen video and marks it completed from Continue", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: "64E0pViEiB8",
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    expect(await screen.findByRole("dialog", { name: /welcome to ade/i })).toBeTruthy();
    expect(screen.getByTitle("Welcome to ADE video")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(markWelcomeVideoSeen).toHaveBeenCalledWith("completed");
    });
    expect(screen.queryByRole("dialog", { name: /welcome to ade/i })).toBeNull();
  });

  it("stays hidden after a seen video until the replay event opens it", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: "64E0pViEiB8",
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
});
