/**
 * The pinned Muse binary's state on one machine, as the `ai.museBinaryStatus`
 * and `ai.ensureMuseBinary` actions report it. Settings polls it while a
 * download runs, so it is cheap: no spawn, no network.
 */
export type MuseBinaryState =
  /** The pinned build is in the tools cache (or ADE_MUSE_EXECUTABLE points at one). */
  | "installed"
  /** A fetch is running in this process. */
  | "downloading"
  /** Pinned for this machine, not on disk, no fetch running. */
  | "missing"
  /** The last fetch in this process failed; `error` says why. */
  | "failed"
  /** ADE pins no Muse build for this platform. */
  | "unsupported";

export type MuseBinaryStatus = {
  state: MuseBinaryState;
  path: string | null;
  /** e.g. `1.4.7-R6101.1`. Null on an unsupported platform. */
  pinnedVersion: string | null;
  receivedBytes: number | null;
  totalBytes: number | null;
  /** The tools cache's error kind (`network`, `integrity`, `disk-space`, …) on `failed`. */
  errorKind: string | null;
  error: string | null;
};
