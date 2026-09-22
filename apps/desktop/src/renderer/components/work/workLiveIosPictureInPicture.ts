/**
 * Native picture-in-picture for the Apple-device corner card.
 *
 * The live view is a canvas (WebCodecs draws H.264 frames there), not a
 * `<video src>`. Chromium's PiP API wants a video element, so Float does
 * `canvas.captureStream()` → a hidden `<video>` → `requestPictureInPicture()`.
 * Closing the PiP window restores the card; a document without PiP keeps the
 * action disabled.
 */

const PIP_VIDEO_ATTR = "data-work-live-pip-video";

export const WORK_LIVE_PIP_UNSUPPORTED_LABEL =
  "Picture in picture is not available in this window";

/**
 * Feature detection only — never enter PiP from here. jsdom has neither
 * `pictureInPictureEnabled` nor `requestPictureInPicture`, which is what the
 * gating test asserts.
 */
export function isWorkLivePictureInPictureSupported(
  doc: Pick<Document, "pictureInPictureEnabled"> | null | undefined = typeof document === "undefined"
    ? null
    : document,
): boolean {
  if (!doc?.pictureInPictureEnabled) return false;
  const proto = typeof HTMLVideoElement === "undefined" ? null : HTMLVideoElement.prototype;
  return typeof proto?.requestPictureInPicture === "function";
}

let pipRequestListeners = new Set<(udid: string | null) => void>();

/** The Simulator-running pill asks the Work card to enter PiP for this device. */
export function requestWorkLiveIosPictureInPicture(udid: string | null): void {
  for (const listener of pipRequestListeners) listener(udid);
}

export function onWorkLiveIosPictureInPictureRequest(
  listener: (udid: string | null) => void,
): () => void {
  pipRequestListeners.add(listener);
  return () => {
    pipRequestListeners.delete(listener);
  };
}

/** Test seam: a request from one test must not reach the next. */
export function resetWorkLiveIosPictureInPictureForTests(): void {
  pipRequestListeners = new Set();
  if (typeof document === "undefined") return;
  for (const node of Array.from(document.querySelectorAll(`[${PIP_VIDEO_ATTR}]`))) {
    node.remove();
  }
}

/**
 * Strip the query string the helper never reads.
 *
 * The stream token is authorised as `Authorization: bearer <token>` and the
 * helper ignores `?token=` on the URL. Passing the minted URL through unchanged
 * would still work today, but a reader that put the secret in the query would
 * look authorised in logs and 403 on the wire.
 */
export function workLiveIosStreamRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const cut = url.indexOf("?");
    return cut >= 0 ? url.slice(0, cut) : url;
  }
}

export type WorkLivePipSession = {
  video: HTMLVideoElement;
  stop: () => void;
};

/**
 * Capture the decoded canvas into a hidden video and open the OS PiP window.
 *
 * The video stays in the document for the life of the session so Chromium has
 * something to keep presenting; `stop` removes it. Callers listen for
 * `leavepictureinpicture` on the video to restore the card.
 */
export async function enterCanvasPictureInPicture(
  canvas: HTMLCanvasElement,
): Promise<WorkLivePipSession> {
  if (!isWorkLivePictureInPictureSupported()) {
    throw new Error(WORK_LIVE_PIP_UNSUPPORTED_LABEL);
  }
  const capture = canvas.captureStream();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute(PIP_VIDEO_ATTR, "");
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;right:0;";
  video.srcObject = capture;
  document.body.appendChild(video);
  await video.play();
  await video.requestPictureInPicture();
  let stopped = false;
  return {
    video,
    stop: () => {
      if (stopped) return;
      stopped = true;
      capture.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture().catch(() => {});
      }
      video.remove();
    },
  };
}
