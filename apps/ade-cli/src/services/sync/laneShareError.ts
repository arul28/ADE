/**
 * The error of a lane share service (`LaneShareHostError`,
 * `LaneShareMoveError`). Error fields do not cross IPC, so the caller sends
 * `wireCode` in the message (`code: sentence`), where
 * `parseCodedErrorMessage` reads it.
 */
export class LaneShareError extends Error {
  constructor(readonly code: string, message: string, readonly directoryCode: string | null = null) {
    super(message);
    this.name = "LaneShareError";
  }

  /** The code a client acts on: a directory refusal carries the directory's own code (`self_invite`, `guest_limit`, …). */
  get wireCode(): string {
    return this.code === "directory_refused" && this.directoryCode ? this.directoryCode : this.code;
  }
}
