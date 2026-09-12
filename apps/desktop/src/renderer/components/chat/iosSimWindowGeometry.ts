/**
 * Finds the device screen inside a captured Simulator window.
 *
 * Window capture hands the renderer the whole Simulator window — title bar,
 * bezel and all — but every tap is aimed at the device screen inside it, so
 * something has to work out where that screen sits in video pixels. That is a
 * ranking pass over capture sources, a bezel heuristic, and a scored search
 * that matches a screenshot against the live frame.
 *
 * This is not a DOM-free module, and it does not claim to be: the calibration
 * pass samples pixels, so it reaches for `Image` and a 2D canvas. What it
 * avoids is React. Split out of `useIosSimLiveView`, this is the part that can
 * be exercised with a stub image surface instead of a mounted panel, which is
 * the only way the offset tables and the confidence cutoff below ever get
 * looked at directly.
 */

import type { IosScreenSnapshot, IosSimulatorWindowSource } from "../../../shared/types";

/** Where the device screen sits inside a captured Simulator window, in video pixels. */
export type WindowScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: "matched" | "heuristic";
};

export function pickSimulatorWindowSource(
  sources: IosSimulatorWindowSource[],
  device: { name: string } | null,
): IosSimulatorWindowSource | null {
  if (!sources.length) return null;
  const deviceName = device?.name.toLowerCase() ?? "";
  return [...sources]
    .filter((source) => !/developer tools|devtools|ade/i.test(source.name))
    .map((source) => {
      const name = source.name.toLowerCase();
      let score = 0;
      if (deviceName && name.includes(deviceName)) score += 80;
      if (name.includes("simulator")) score += 50;
      if (/\biphone\b|\bipad\b|\bios\b/.test(name)) score += 30;
      if (name.includes("apple tv") || name.includes("watch")) score -= 20;
      return { source, score };
    })
    .filter(({ source, score }) => {
      const name = source.name.toLowerCase();
      if (deviceName) return name.includes(deviceName) || name.includes("simulator");
      return score >= 50;
    })
    .sort((a, b) => b.score - a.score || a.source.name.localeCompare(b.source.name))[0]?.source ?? null;
}

export function buildDesktopCaptureConstraints(sourceId: string, maxFrameRate: number): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        minFrameRate: Math.min(30, maxFrameRate),
        maxFrameRate,
      },
      optional: [{ cursor: "never" }],
    },
  } as unknown as MediaStreamConstraints;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load iOS snapshot for window calibration."));
    image.src = src;
  });
}

export function heuristicWindowScreenRect(
  videoWidth: number,
  videoHeight: number,
  screenWidth: number | null | undefined,
  screenHeight: number | null | undefined,
): WindowScreenRect | null {
  if (videoWidth <= 0 || videoHeight <= 0 || !screenWidth || !screenHeight) return null;
  const aspect = screenWidth / screenHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const widthLimited = videoWidth * 0.91;
  const heightLimited = videoHeight * 0.9 * aspect;
  const width = Math.min(widthLimited, heightLimited);
  const height = width / aspect;
  const residualX = Math.max(0, videoWidth - width);
  const residualY = Math.max(0, videoHeight - height);
  return {
    x: residualX / 2,
    y: Math.min(residualY, Math.max(videoHeight * 0.065, residualY * 0.82)),
    width,
    height,
    confidence: 0.45,
    source: "heuristic",
  };
}

function luminanceAt(data: Uint8ClampedArray, index: number): number {
  return (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
}

export async function calibrateWindowScreenRect(
  video: HTMLVideoElement,
  snapshot: IosScreenSnapshot,
): Promise<WindowScreenRect | null> {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const screenWidth = snapshot.screenshot.width;
  const screenHeight = snapshot.screenshot.height;
  const fallback = heuristicWindowScreenRect(videoWidth, videoHeight, screenWidth, screenHeight);
  if (!fallback || !snapshot.screenshot.dataUrl || video.readyState < video.HAVE_CURRENT_DATA) return fallback;

  try {
    const image = await loadImage(snapshot.screenshot.dataUrl);
    const aspect = screenWidth && screenHeight ? screenWidth / screenHeight : image.naturalWidth / image.naturalHeight;
    const sampleWidth = 28;
    const sampleHeight = Math.max(40, Math.round(sampleWidth / aspect));

    const referenceCanvas = document.createElement("canvas");
    referenceCanvas.width = sampleWidth;
    referenceCanvas.height = sampleHeight;
    const referenceCtx = referenceCanvas.getContext("2d", { willReadFrequently: true });
    if (!referenceCtx) return fallback;
    referenceCtx.drawImage(image, 0, 0, sampleWidth, sampleHeight);
    const reference = referenceCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;

    const videoCanvas = document.createElement("canvas");
    videoCanvas.width = videoWidth;
    videoCanvas.height = videoHeight;
    const videoCtx = videoCanvas.getContext("2d");
    if (!videoCtx) return fallback;
    videoCtx.drawImage(video, 0, 0, videoWidth, videoHeight);

    const candidateCanvas = document.createElement("canvas");
    candidateCanvas.width = sampleWidth;
    candidateCanvas.height = sampleHeight;
    const candidateCtx = candidateCanvas.getContext("2d", { willReadFrequently: true });
    if (!candidateCtx) return fallback;

    let bestRect: WindowScreenRect = fallback;
    let bestScore = Number.POSITIVE_INFINITY;
    const heightScales = [0.96, 0.98, 1, 1.02, 1.04];
    const xOffsets = [-0.04, -0.025, -0.01, 0, 0.01, 0.025, 0.04];
    const yOffsets = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06];

    for (const heightScale of heightScales) {
      const height = fallback.height * heightScale;
      const width = height * aspect;
      if (width <= 0 || height <= 0 || width > videoWidth || height > videoHeight) continue;
      const baseX = fallback.x + ((fallback.width - width) / 2);
      const baseY = fallback.y + ((fallback.height - height) / 2);
      for (const xOffset of xOffsets) {
        for (const yOffset of yOffsets) {
          const x = Math.max(0, Math.min(videoWidth - width, baseX + (videoWidth * xOffset)));
          const y = Math.max(0, Math.min(videoHeight - height, baseY + (videoHeight * yOffset)));
          candidateCtx.clearRect(0, 0, sampleWidth, sampleHeight);
          candidateCtx.drawImage(videoCanvas, x, y, width, height, 0, 0, sampleWidth, sampleHeight);
          const candidate = candidateCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
          let score = 0;
          for (let index = 0; index < reference.length; index += 4) {
            score += Math.abs(luminanceAt(reference, index) - luminanceAt(candidate, index));
          }
          score /= reference.length / 4;
          if (score < bestScore) {
            bestScore = score;
            bestRect = {
              x,
              y,
              width,
              height,
              confidence: Math.max(0, Math.min(1, 1 - (score / 255))),
              source: "matched",
            };
          }
        }
      }
    }
    return bestRect.confidence > 0.55 ? bestRect : fallback;
  } catch {
    return fallback;
  }
}
