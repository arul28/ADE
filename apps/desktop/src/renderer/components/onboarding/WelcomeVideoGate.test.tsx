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
import { docs } from "../../onboarding/docsLinks";

const DIALOG_NAME = /welcome to ade/i;

describe("WelcomeVideoGate", () => {
  const originalAde = window.ade;
  const getWelcomeVideoState = vi.fn();
  const markWelcomeVideoSeen = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    window.history.pushState({}, "", "/");
    Object.assign(navigator, { clipboard: undefined });
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

  it("opens for an unseen video and dismisses from the close button", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    expect(await screen.findByRole("dialog", { name: DIALOG_NAME })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /close welcome/i }));

    await waitFor(() => {
      expect(markWelcomeVideoSeen).toHaveBeenCalledWith("dismissed");
    });
    expect(screen.queryByRole("dialog", { name: DIALOG_NAME })).toBeNull();
  });

  it("lazily loads the sandboxed video iframe only after the poster is clicked", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    await screen.findByRole("dialog", { name: DIALOG_NAME });

    // No iframe up front; the poster stands in until the user opts to play.
    expect(screen.queryByTitle("Welcome to ADE video")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /play the ade intro video/i }));

    const video = screen.getByTitle("Welcome to ADE video");
    expect(video.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-presentation allow-popups",
    );
    expect(video.getAttribute("allow")).toBe("autoplay; encrypted-media; picture-in-picture");
    expect(video.getAttribute("src")).toContain("autoplay=1");
  });

  it("uses route-stable public asset URLs on nested browser routes", async () => {
    window.history.pushState({}, "", "/automations/templates");
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    await screen.findByRole("dialog", { name: DIALOG_NAME });

    expect(document.querySelector('img[aria-hidden="true"]')?.getAttribute("src")).toBe(
      "/logo.png",
    );
    expect(
      screen
        .getByRole("button", { name: /^desktop:/i })
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("/welcome/desktop.webp");
    expect(
      screen
        .getByRole("button", { name: /^mobile:/i })
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("/welcome/mobile.webp");
    expect(
      screen
        .getByRole("button", { name: /^terminal:/i })
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("/welcome/tui.webp");
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
    expect(screen.queryByRole("dialog", { name: DIALOG_NAME })).toBeNull();

    window.dispatchEvent(new Event(ADE_WELCOME_VIDEO_REPLAY_EVENT));

    expect(await screen.findByRole("dialog", { name: DIALOG_NAME })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close welcome/i }));

    await waitFor(() => {
      expect(markWelcomeVideoSeen).toHaveBeenCalledWith("dismissed");
    });
    expect(screen.queryByRole("dialog", { name: DIALOG_NAME })).toBeNull();
  });

  it("downloads the mobile app from the QR panel", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    fireEvent.click(await screen.findByRole("button", { name: /download for ios/i }));

    expect(openExternal).toHaveBeenCalledWith(ADE_MOBILE_TESTFLIGHT_URL);
  });

  it("copies the install link through the desktop clipboard bridge when available", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    window.ade = ({
      app: {
        ...window.ade.app,
        writeClipboardText,
      },
    } as unknown) as typeof window.ade;
    Object.assign(navigator, { clipboard: { writeText } });

    render(<WelcomeVideoGate />);

    fireEvent.click(await screen.findByRole("button", { name: /copy install link/i }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(ADE_MOBILE_TESTFLIGHT_URL);
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /link copied/i })).toBeTruthy();
  });

  it("falls back to the browser clipboard and confirms it in place", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<WelcomeVideoGate />);

    fireEvent.click(await screen.findByRole("button", { name: /copy install link/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(ADE_MOBILE_TESTFLIGHT_URL);
    });
    expect(await screen.findByRole("button", { name: /link copied/i })).toBeTruthy();
  });

  it("reports copy failure when the Clipboard API is unavailable", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });
    Object.assign(navigator, { clipboard: undefined });

    render(<WelcomeVideoGate />);

    fireEvent.click(await screen.findByRole("button", { name: /copy install link/i }));

    expect(await screen.findByRole("button", { name: /copy failed/i })).toBeTruthy();
  });

  it("opens the matching docs section from a surface tile", async () => {
    getWelcomeVideoState.mockResolvedValue({
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    });

    render(<WelcomeVideoGate />);

    fireEvent.click(await screen.findByRole("button", { name: /^desktop:/i }));

    expect(openExternal).toHaveBeenCalledWith(docs.home);
  });
});
