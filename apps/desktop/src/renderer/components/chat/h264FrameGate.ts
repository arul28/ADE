/**
 * The decoder-safety gate for pushed H.264 records.
 *
 * The host may skip frames under backpressure; its contract is that a resumed
 * stream always begins again at a keyframe. Every P-frame until that keyframe
 * references a picture the decoder never saw, and handing those to WebCodecs
 * paints corruption that outlives the drop. The same rule applies after a
 * decoder error or a config change: the decoder has no reference picture, so
 * only a keyframe may restart the picture.
 *
 * Pure and synchronous, so the rule is testable without a decoder or a socket.
 * The iOS live view carries the same state machine in
 * `MacDesktopStreamFrameGate`.
 */

export type H264FrameGate = {
  /**
   * Whether a frame may reach the decoder. The first frame after a reset (or
   * after a sequence gap) must be a keyframe.
   */
  shouldDeliver(keyframe: boolean, seq: number): boolean;
  /** The decoder lost its references; hold P-frames until the next keyframe. */
  requireKeyframe(): void;
  /** A new subscription or a rebuilt decoder: start over from a keyframe. */
  reset(): void;
  readonly awaitingKeyframe: boolean;
  readonly lastSeq: number | null;
};

export function createH264FrameGate(): H264FrameGate {
  let lastSeq: number | null = null;
  let awaitingKeyframe = true;

  return {
    shouldDeliver(keyframe: boolean, seq: number): boolean {
      if (lastSeq !== null && seq > lastSeq + 1) {
        // A gap means the host skipped records: the reference chain is broken.
        awaitingKeyframe = true;
      }
      lastSeq = seq;
      if (awaitingKeyframe) {
        if (!keyframe) return false;
        awaitingKeyframe = false;
      }
      return true;
    },
    requireKeyframe(): void {
      awaitingKeyframe = true;
    },
    reset(): void {
      lastSeq = null;
      awaitingKeyframe = true;
    },
    get awaitingKeyframe() {
      return awaitingKeyframe;
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}
