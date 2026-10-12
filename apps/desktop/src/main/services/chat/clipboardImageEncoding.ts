/** Long edge of the first JPEG attempt: sharp on any display, small on disk. */
const FIRST_JPEG_EDGE_PX = 4096;
/** Below this the picture is not worth sending; the caller reports the ceiling. */
const MIN_JPEG_EDGE_PX = 768;
const JPEG_QUALITY = 85;
/** Each retry shrinks the long edge to this fraction of the last one. */
const JPEG_EDGE_STEP = 0.75;

export type EncodedClipboardImage = {
  data: Buffer;
  filename: string;
  mimeType: string;
};

/** The four `NativeImage` methods the encoder uses; Electron's image satisfies it. */
type EncodableImage = {
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
  resize(options: { width?: number; height?: number; quality?: "good" | "better" | "best" }): EncodableImage;
};

/**
 * Encodes a clipboard image so it fits the bytes-path attachment ceiling.
 *
 * The clipboard never holds the file a person copied. Copying a photo out of
 * Messages, Photos or Preview puts a decoded bitmap there, and Electron can
 * only hand it back re-encoded — as PNG. A 12 MP phone photo that was 2 MB as
 * HEIC comes out of `toPNG()` at 15–30 MB, over the 10 MB ceiling of the base64
 * path, so every paste of it failed. Screenshots stay PNG (they are small and
 * text in them should stay crisp); only a PNG over the ceiling is re-encoded as
 * JPEG, shrinking the long edge until it fits. The models scale anything past
 * ~1.5k px down anyway, so the shrink costs nothing anyone can see.
 */
export function encodeClipboardImageWithinCap(
  image: EncodableImage,
  maxBytes: number,
): EncodedClipboardImage | null {
  const png = image.toPNG();
  if (png.byteLength > 0 && png.byteLength <= maxBytes) {
    return { data: png, filename: "clipboard.png", mimeType: "image/png" };
  }
  const { width, height } = image.getSize();
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) return null;
  let edge = Math.min(FIRST_JPEG_EDGE_PX, longEdge);
  for (;;) {
    const scaled = edge < longEdge
      ? image.resize(width >= height ? { width: edge, quality: "good" } : { height: edge, quality: "good" })
      : image;
    const jpeg = scaled.toJPEG(JPEG_QUALITY);
    if (jpeg.byteLength > 0 && jpeg.byteLength <= maxBytes) {
      return { data: jpeg, filename: "clipboard.jpg", mimeType: "image/jpeg" };
    }
    if (edge <= MIN_JPEG_EDGE_PX) return null;
    edge = Math.max(MIN_JPEG_EDGE_PX, Math.floor(edge * JPEG_EDGE_STEP));
  }
}
