/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

interface FakeStatus {
  installed: boolean;
  binaryInstalled: boolean;
  modelInstalled: boolean;
  downloading: boolean;
  binaryPath: string | null;
  modelPath: string | null;
}

function statusFor(modelInstalled: boolean): FakeStatus {
  return {
    installed: modelInstalled,
    binaryInstalled: true,
    modelInstalled,
    downloading: false,
    binaryPath: "/app/whisper/whisper-cli",
    modelPath: modelInstalled ? "/userData/whisper/ggml-base.en.bin" : null,
  };
}

afterEach(() => {
  cleanup();
  vi.resetModules();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("useVoiceModelInstalled", () => {
  it("flips false → true when the model download completes, without remounting", async () => {
    // Mirrors the real bug scenario: a chat composer stays mounted while the
    // model is downloaded from Settings. The mic must enable live (no restart).
    let modelInstalled = false;
    const status = vi.fn(async () => statusFor(modelInstalled));
    const downloadModel = vi.fn(async () => {
      modelInstalled = true; // main resolves the model fresh on the next call
      return statusFor(true);
    });
    (window as unknown as { ade: unknown }).ade = {
      transcription: {
        status,
        downloadModel,
        onModelDownloadProgress: () => () => {},
      },
    };

    // Fresh singleton + hook from the same (reset) module graph so the hook
    // subscribes to the very installer the download drives.
    const { useVoiceModelInstalled } = await import("./useVoiceModelInstalled");
    const { globalVoiceModelInstaller } = await import(
      "../services/globalVoiceModelInstaller"
    );

    const { result } = renderHook(() => useVoiceModelInstalled(true));

    // Unknown until the first probe resolves, then known-absent.
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false));

    // Download completes on the shared singleton — no remount of the consumer.
    await act(async () => {
      await globalVoiceModelInstaller.start();
    });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("resolves to false (not stuck null) when the transcription bridge is absent", async () => {
    // Degraded / non-Electron surface: no window.ade.transcription. The hook must
    // still resolve to known-absent (false) so the mic shows its download CTA
    // rather than hanging on null forever. Guards the refresh() no-bridge branch
    // that marks `probed` even without an API — the mechanic the live-flip relies
    // on to leave the "unknown" state.
    delete (window as unknown as { ade?: unknown }).ade;

    const { useVoiceModelInstalled } = await import("./useVoiceModelInstalled");
    const { globalVoiceModelInstaller } = await import(
      "../services/globalVoiceModelInstaller"
    );
    const { result } = renderHook(() => useVoiceModelInstalled(true));

    // The no-bridge probe resolves synchronously (no IPC round-trip), so the hook
    // settles directly on known-absent rather than passing through a null window.
    await waitFor(() => expect(result.current).toBe(false));

    const state = globalVoiceModelInstaller.getState();
    expect(state.probed).toBe(true);
    expect(state.binaryInstalled).toBe(false);
  });

  it("returns null while voice input is disabled (no probe)", async () => {
    const status = vi.fn(async () => statusFor(true));
    (window as unknown as { ade: unknown }).ade = { transcription: { status } };

    const { useVoiceModelInstalled } = await import("./useVoiceModelInstalled");
    const { result } = renderHook(() => useVoiceModelInstalled(false));

    expect(result.current).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });
});
