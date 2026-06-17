/**
 * App-global voice-model installer (renderer singleton).
 *
 * The ~141 MB whisper speech model is downloaded on demand (not bundled). The
 * actual download runs in the MAIN process (transcription.downloadModel), which
 * is single-flight and streams to disk — so it keeps running even if the user
 * navigates away from Settings or unmounts the UI that started it. This module
 * is the renderer-side source of truth for that lifecycle: it owns the progress
 * subscription and install state at module scope (not tied to any component),
 * so any surface (Settings, the chat mic) reads a consistent state and a
 * navigation away never loses an in-flight download.
 *
 * Live flip: the main process resolves the model dynamically (it stats disk on
 * every status/transcribe call), and every voice surface — Settings and each
 * chat mic — subscribes to this singleton. So when a download completes we just
 * push the new state and the mic enables everywhere immediately; no app restart.
 */

export type VoiceModelPhase = "idle" | "downloading" | "installed" | "error";

export interface VoiceModelInstallState {
  phase: VoiceModelPhase;
  /** Bundled whisper-cli binary present (the half that ships with the app). */
  binaryInstalled: boolean;
  /** Downloaded model present on disk. */
  modelInstalled: boolean;
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
  /** True once we've probed the main process at least once (else state is unknown). */
  probed: boolean;
}

type Listener = (state: VoiceModelInstallState) => void;

// Best-effort total for the progress bar before the server reports content-length.
export const VOICE_MODEL_BYTES = 147_964_211;
/** User-facing model size label, derived once so prose can't drift from the byte count. */
export const VOICE_MODEL_SIZE_LABEL = `${Math.round(VOICE_MODEL_BYTES / 1024 / 1024)} MB`;

const DEFAULT_DOWNLOAD_ERROR =
  "Download failed — check your internet connection and try again.";

class VoiceModelInstaller {
  private state: VoiceModelInstallState = {
    phase: "idle",
    binaryInstalled: false,
    modelInstalled: false,
    receivedBytes: 0,
    totalBytes: null,
    error: null,
    probed: false,
  };

  private readonly listeners = new Set<Listener>();
  private progressUnsub: (() => void) | null = null;
  private refreshing = false;
  private inFlight: Promise<void> | null = null;

  getState(): VoiceModelInstallState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<VoiceModelInstallState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // A listener throwing must not break the others or the install flow.
      }
    }
  }

  /**
   * Probe whether the binary + model are present. Safe to call repeatedly; never
   * clobbers an in-flight download. Marks `probed` so consumers can distinguish
   * "unknown" from "known absent".
   */
  async refresh(): Promise<void> {
    const api = window.ade?.transcription;
    if (!api?.status) {
      this.set({ binaryInstalled: false, modelInstalled: false, probed: true });
      return;
    }
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const status = await api.status();
      const modelInstalled = Boolean(status.modelInstalled);
      // Never downgrade an in-flight download or a sticky error; otherwise
      // reflect on-disk presence.
      let phase = this.state.phase;
      if (phase !== "downloading") {
        if (modelInstalled) {
          phase = "installed";
        } else if (phase !== "error") {
          phase = "idle";
        }
      }
      this.set({
        binaryInstalled: Boolean(status.binaryInstalled),
        modelInstalled,
        phase,
        probed: true,
      });
    } catch {
      // Best-effort probe — leave prior state intact on failure.
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Start (or join) the model download. Idempotent: concurrent callers share the
   * single in-flight download; a completed/installed model is a no-op.
   */
  start(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    // Already present on disk → nothing to download (the UI doesn't offer the
    // button in this state, but keep start() honest about its own no-op claim).
    if (this.state.modelInstalled) return Promise.resolve();

    const api = window.ade?.transcription;
    if (!api?.downloadModel) {
      this.set({ phase: "error", error: "Voice model download is unavailable in this build." });
      return Promise.resolve();
    }

    this.set({
      phase: "downloading",
      error: null,
      receivedBytes: 0,
      totalBytes: VOICE_MODEL_BYTES,
    });

    // Register the progress listener for the lifetime of this download. It lives
    // at module scope, so it survives the UI that kicked it off unmounting.
    this.progressUnsub?.();
    this.progressUnsub =
      api.onModelDownloadProgress?.((progress) => {
        this.set({
          receivedBytes: progress.receivedBytes,
          totalBytes: progress.totalBytes ?? this.state.totalBytes,
        });
      }) ?? null;

    this.inFlight = (async () => {
      try {
        const next = await api.downloadModel();
        // Main resolves the model on every call, and every mic subscribes here,
        // so this push enables voice input live — no restart.
        this.set({
          phase: "installed",
          modelInstalled: next?.modelInstalled ?? true,
          binaryInstalled: next?.binaryInstalled ?? this.state.binaryInstalled,
          probed: true,
          error: null,
        });
      } catch (error) {
        this.set({
          phase: "error",
          error: error instanceof Error && error.message ? error.message : DEFAULT_DOWNLOAD_ERROR,
        });
      } finally {
        this.progressUnsub?.();
        this.progressUnsub = null;
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}

export const globalVoiceModelInstaller = new VoiceModelInstaller();
