/**
 * The framing every device video stream writes and the renderer reads: the
 * iOS simulator, Mac Desktop, and the Android emulator.
 *
 * A chunked HTTP body has no message boundaries, so every record carries a
 * fixed 12-byte header. The constants live here, in one module both
 * processes import, because two independent copies of a binary contract
 * desynchronise at runtime instead of failing to compile.
 */
export const VIDEO_RECORD_MAGIC = 0xade1f00d;
export const VIDEO_RECORD_HEADER_BYTES = 12;
export const VIDEO_RECORD_TYPE_CONFIG = 1;
export const VIDEO_RECORD_TYPE_ACCESS_UNIT = 2;
export const VIDEO_RECORD_FLAG_KEYFRAME = 1;
