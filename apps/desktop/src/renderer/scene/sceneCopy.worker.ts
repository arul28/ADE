/**
 * Makes the screen-sized copy of a user's scene picture off the page's
 * thread, run as a worker by `userScenes.ts`. One request, one answer: the
 * page sends the stored picture and the copy's size, and gets a JPEG back.
 * Decoding a 5120-pixel picture and scaling it takes a few hundred
 * milliseconds; here that time never blocks input or a frame.
 */

export type SceneCopyRequest = { blob: Blob; width: number; height: number; quality: number };
export type SceneCopyResponse = { blob: Blob } | { error: string };

/** The worker's own global scope, as far as this program uses it. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SceneCopyRequest>) => void) | null;
  postMessage(message: SceneCopyResponse): void;
};

async function makeCopy({ blob, width, height, quality }: SceneCopyRequest): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context in the worker");
    context.imageSmoothingQuality = "high";
    // The size again: a browser that ignores the resize options hands back the
    // full picture, which must be scaled here, not cropped.
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/jpeg", quality });
  } finally {
    bitmap.close();
  }
}

scope.onmessage = (event) => {
  makeCopy(event.data).then(
    (blob) => scope.postMessage({ blob }),
    (error: unknown) => scope.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
};
