import { useEffect, useState } from "react";
import { fromHsl, paletteFromPixels, toHsl, type Rgb, type ScenePalette } from "../../scene/scenePalette";

const SAMPLE_EDGE = 40;
const memory = new Map<string, ScenePalette>();

function parseColor(value: string): Rgb | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const rgb = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** A five-stop ramp around one colour, for a picture we can't read. */
export function paletteFromTint(tint: string): ScenePalette {
  const base = parseColor(tint) ?? [124, 92, 255];
  const [h, s] = toHsl(base);
  const sat = Math.max(0.45, s);
  return {
    ramp: [
      fromHsl(h, sat * 0.6, 0.09),
      // `toHsl` hues run 0–1, so a shift in degrees is divided by 360.
      fromHsl(h + 340 / 360, sat * 0.8, 0.22),
      fromHsl(h, sat, 0.38),
      fromHsl(h + 24 / 360, sat, 0.52),
      fromHsl(h + 48 / 360, sat * 0.9, 0.66),
    ],
    luma: 0.3,
  };
}

/**
 * The profile picture's colours, read the same way a scene picture's are, so
 * the Account banner's mesh matches the avatar floating on it. Falls back to
 * the sign-in provider's tint when there is no picture or its host doesn't
 * allow reading its pixels (CORS).
 */
export function useProfilePalette(imageUrl: string | null, tint: string): ScenePalette {
  const [palette, setPalette] = useState<ScenePalette>(() =>
    (imageUrl ? memory.get(imageUrl) : undefined) ?? paletteFromTint(tint));
  useEffect(() => {
    let cancelled = false;
    const fallback = paletteFromTint(tint);
    if (!imageUrl) {
      setPalette(fallback);
      return;
    }
    const known = memory.get(imageUrl);
    if (known) {
      setPalette(known);
      return;
    }
    setPalette(fallback);
    const sample = (src: string, crossOrigin: boolean, onFail: () => void) => {
      const image = new Image();
      if (crossOrigin) image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onerror = () => {
        if (!cancelled) onFail();
      };
      image.onload = () => {
        if (cancelled) return;
        try {
          const canvas = document.createElement("canvas");
          const scale = SAMPLE_EDGE / Math.max(image.naturalWidth, image.naturalHeight, 1);
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return;
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const next = paletteFromPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
          memory.set(imageUrl, next);
          setPalette(next);
        } catch {
          onFail();
        }
      };
      image.src = src;
    };
    // Most avatar hosts send no CORS headers, so a direct read fails; then
    // main fetches the signed-in account's own picture and hands it over.
    sample(imageUrl, true, () => {
      const getDataUrl = window.ade?.account?.getAvatarDataUrl;
      if (!getDataUrl) return;
      void getDataUrl()
        .then((dataUrl) => {
          if (dataUrl && !cancelled) sample(dataUrl, false, () => {});
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [imageUrl, tint]);
  return palette;
}

export function rgbCss([r, g, b]: Rgb, alpha = 1): string {
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}
